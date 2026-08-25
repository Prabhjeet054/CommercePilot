import OpenAI, { APIUserAbortError, BadRequestError } from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import { z, ZodFirstPartyTypeKind, type ZodTypeAny } from "zod";
import type { Env } from "../../config/env";
import {
  assertNonEmptyPrompt,
  debugLlm,
  generateStructuredWith,
  LLMConfigError,
  LLMSchemaUnsupportedError,
  LLMTimeoutError,
  type GenerateStructuredInput,
  type LLMProvider,
  type StructuredCompleteArgs,
} from "../llm-provider";

const DEFAULT_MODEL = "gpt-4o-mini";
const SYSTEM_PROMPT =
  "You return JSON that matches the provided schema. Do not wrap the JSON in markdown fences or add commentary.";

export type ChatCompletionLike = {
  chat: {
    completions: {
      create: (
        body: {
          model: string;
          messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
          response_format: unknown;
        },
        options?: { signal?: AbortSignal },
      ) => Promise<{ choices?: Array<{ message?: { content?: string | null } }> }>;
    };
  };
};

export type RealLLMProviderOptions = {
  apiKey: string;
  provider?: string;
  model?: string;
  client?: ChatCompletionLike;
};

function kindOf(schema: ZodTypeAny): ZodFirstPartyTypeKind {
  return schema._def.typeName as ZodFirstPartyTypeKind;
}

function unwrap(schema: ZodTypeAny): ZodTypeAny {
  let current = schema;
  for (;;) {
    const kind = kindOf(current);
    if (
      kind === ZodFirstPartyTypeKind.ZodOptional ||
      kind === ZodFirstPartyTypeKind.ZodNullable ||
      kind === ZodFirstPartyTypeKind.ZodDefault
    ) {
      current = current._def.innerType as ZodTypeAny;
      continue;
    }
    if (kind === ZodFirstPartyTypeKind.ZodEffects) {
      const effect = current._def.effect as { type: string };
      if (effect.type === "transform" || effect.type === "preprocess") {
        throw new LLMSchemaUnsupportedError(
          `OpenAI structured output cannot represent Zod ${effect.type}s at this field. Use a plain z.object with string/number/boolean/array/object fields (optional fields as .nullable() or .optional()), not preprocess/transform.`,
        );
      }
      current = current._def.schema as ZodTypeAny;
      continue;
    }
    if (kind === ZodFirstPartyTypeKind.ZodBranded) {
      current = current._def.type as ZodTypeAny;
      continue;
    }
    return current;
  }
}

function assertRepresentable(schema: ZodTypeAny, path: string): void {
  const inner = unwrap(schema);
  const kind = kindOf(inner);
  const here = path || "(root)";

  switch (kind) {
    case ZodFirstPartyTypeKind.ZodObject: {
      const shape = (inner as z.ZodObject<z.ZodRawShape>).shape;
      for (const [key, field] of Object.entries(shape)) {
        assertRepresentable(field, path ? `${path}.${key}` : key);
      }
      return;
    }
    case ZodFirstPartyTypeKind.ZodArray:
      assertRepresentable(inner._def.type as ZodTypeAny, `${here}[]`);
      return;
    case ZodFirstPartyTypeKind.ZodString:
    case ZodFirstPartyTypeKind.ZodNumber:
    case ZodFirstPartyTypeKind.ZodBoolean:
    case ZodFirstPartyTypeKind.ZodNull:
    case ZodFirstPartyTypeKind.ZodLiteral:
    case ZodFirstPartyTypeKind.ZodEnum:
    case ZodFirstPartyTypeKind.ZodNativeEnum:
      return;
    case ZodFirstPartyTypeKind.ZodUnion:
    case ZodFirstPartyTypeKind.ZodDiscriminatedUnion: {
      const options = inner._def.options as unknown;
      const list: ZodTypeAny[] = Array.isArray(options)
        ? options
        : options instanceof Map
          ? [...options.values()]
          : Object.values((options ?? {}) as Record<string, ZodTypeAny>);
      for (const option of list) {
        assertRepresentable(option, here);
      }
      return;
    }
    case ZodFirstPartyTypeKind.ZodRecord:
      throw new LLMSchemaUnsupportedError(
        `Field "${here}" uses z.record(), which OpenAI strict structured output cannot represent (additionalProperties must be false). Replace it with z.object({ key: ... }) listing explicit keys.`,
      );
    case ZodFirstPartyTypeKind.ZodAny:
    case ZodFirstPartyTypeKind.ZodUnknown:
      throw new LLMSchemaUnsupportedError(
        `Field "${here}" uses z.any()/z.unknown(), which OpenAI structured output cannot constrain. Specify a concrete z.object / z.array / primitive schema.`,
      );
    case ZodFirstPartyTypeKind.ZodTuple:
      throw new LLMSchemaUnsupportedError(
        `Field "${here}" uses z.tuple(), which OpenAI structured output does not accept. Use z.array(...) or named object fields.`,
      );
    case ZodFirstPartyTypeKind.ZodDate:
    case ZodFirstPartyTypeKind.ZodBigInt:
    case ZodFirstPartyTypeKind.ZodMap:
    case ZodFirstPartyTypeKind.ZodSet:
    case ZodFirstPartyTypeKind.ZodFunction:
    case ZodFirstPartyTypeKind.ZodPromise:
    case ZodFirstPartyTypeKind.ZodLazy:
    case ZodFirstPartyTypeKind.ZodIntersection:
      throw new LLMSchemaUnsupportedError(
        `Field "${here}" uses ${kind}, which OpenAI structured-output JSON Schema cannot represent. Stick to objects, arrays, strings, numbers, booleans, enums, and nullables.`,
      );
    default:
      throw new LLMSchemaUnsupportedError(
        `Field "${here}" uses unsupported Zod type ${kind}. OpenAI structured output needs a root z.object with JSON-serializable fields.`,
      );
  }
}

export function assertOpenAIStructuredSchema(schema: ZodTypeAny): void {
  const root = unwrap(schema);
  const rootKind = kindOf(root);
  if (rootKind === ZodFirstPartyTypeKind.ZodRecord) {
    throw new LLMSchemaUnsupportedError(
      "OpenAI structured output cannot represent a root z.record() (additionalProperties must be false). Use z.object({ key: ... }) with explicit keys.",
    );
  }
  if (rootKind !== ZodFirstPartyTypeKind.ZodObject) {
    throw new LLMSchemaUnsupportedError(
      "OpenAI structured output requires a root z.object({ ... }). Wrap primitive values in an object so the model returns JSON rather than a bare value.",
    );
  }
  assertRepresentable(schema, "");
  try {
    zodResponseFormat(schema, "structured_output");
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new LLMSchemaUnsupportedError(
      `This Zod schema cannot be converted to OpenAI structured-output JSON Schema: ${detail}. Use a root z.object with explicit keys (no z.record, z.any, tuples, or transforms).`,
    );
  }
}

function resolveProviderName(raw: string | undefined): "openai" {
  const name = (raw ?? "openai").trim().toLowerCase();
  if (name.length === 0 || name === "openai") {
    return "openai";
  }
  throw new LLMConfigError(
    `Unsupported LLM_PROVIDER "${raw}". This adapter implements OpenAI structured outputs only. Set LLM_PROVIDER=openai, or LLM_PROVIDER=mock for tests.`,
  );
}

export class RealLLMProvider implements LLMProvider {
  private readonly injectedClient: ChatCompletionLike | undefined;
  private liveClient: ChatCompletionLike | undefined;
  private readonly apiKey: string;
  private readonly model: string;

  constructor(options: RealLLMProviderOptions) {
    resolveProviderName(options.provider);
    const apiKey = options.apiKey?.trim() ?? "";
    if (!apiKey || apiKey === "replace-me") {
      throw new LLMConfigError(
        "LLM_PROVIDER_API_KEY is required for the real provider. Set it in .env; never commit a real key.",
      );
    }

    this.apiKey = apiKey;
    this.model = options.model?.trim() || DEFAULT_MODEL;
    this.injectedClient = options.client;
  }

  private client(): ChatCompletionLike {
    if (this.injectedClient) {
      return this.injectedClient;
    }
    if (!this.liveClient) {
      this.liveClient = new OpenAI({
        apiKey: this.apiKey,
        maxRetries: 0,
      }) as ChatCompletionLike;
    }
    return this.liveClient;
  }

  static fromEnv(env: Pick<Env, "LLM_PROVIDER" | "LLM_PROVIDER_API_KEY">): RealLLMProvider {
    return new RealLLMProvider({
      provider: env.LLM_PROVIDER,
      apiKey: env.LLM_PROVIDER_API_KEY ?? "",
    });
  }

  async generateStructured<T>(input: GenerateStructuredInput<T>): Promise<T> {
    assertNonEmptyPrompt(input.prompt);
    assertOpenAIStructuredSchema(input.schema);

    const responseFormat = zodResponseFormat(input.schema, "structured_output");

    return generateStructuredWith(input, (args) => this.complete(args, responseFormat));
  }

  private async complete(args: StructuredCompleteArgs, responseFormat: unknown): Promise<string> {
    debugLlm("openai.complete", {
      attempt: args.attempt,
      model: this.model,
      prompt: args.prompt,
    });

    const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: args.prompt },
    ];
    if (args.attempt === 2 && args.previousRaw !== undefined) {
      messages.push({ role: "assistant", content: args.previousRaw });
      messages.push({
        role: "user",
        content: `That response was not valid (${args.previousIssue ?? "schema mismatch"}). Return JSON that matches the schema, with no markdown.`,
      });
    }

    try {
      const completion = await this.client().chat.completions.create(
        {
          model: this.model,
          messages,
          response_format: responseFormat,
        },
        { signal: args.signal },
      );
      const content = completion.choices?.[0]?.message?.content;
      return typeof content === "string" ? content : "";
    } catch (err) {
      if (err instanceof LLMTimeoutError || err instanceof APIUserAbortError || args.signal.aborted) {
        throw err;
      }
      if (err instanceof BadRequestError) {
        throw new LLMSchemaUnsupportedError(
          `OpenAI rejected the structured-output schema (${err.message}). Use a root z.object with explicit JSON-serializable keys; OpenAI strict mode forbids additionalProperties, records, and many unions.`,
        );
      }
      throw err;
    }
  }
}

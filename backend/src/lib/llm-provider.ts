import type { ZodSchema } from "zod";

export const DEFAULT_LLM_TIMEOUT_MS = 20_000;

export type GenerateStructuredInput<T> = {
  prompt: string;
  schema: ZodSchema<T>;
  timeoutMs?: number;
};

export interface LLMProvider {
  generateStructured<T>(input: GenerateStructuredInput<T>): Promise<T>;
}

export type StructuredCompleteArgs = {
  prompt: string;
  attempt: 1 | 2;
  signal: AbortSignal;
  previousRaw?: string;
  previousIssue?: string;
};

export type StructuredComplete = (args: StructuredCompleteArgs) => Promise<string>;

export class LLMTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`LLM request timed out after ${timeoutMs}ms`);
    this.name = "LLMTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

export class LLMOutputError extends Error {
  readonly rawOutput: string;
  readonly issue: string;

  constructor(message: string, rawOutput: string, issue: string) {
    super(message);
    this.name = "LLMOutputError";
    this.rawOutput = rawOutput;
    this.issue = issue;
  }
}

export class LLMPromptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LLMPromptError";
  }
}

export class LLMSchemaUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LLMSchemaUnsupportedError";
  }
}

export class LLMConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LLMConfigError";
  }
}

const SENSITIVE_KEY = /api[_-]?key|secret|token|password|authorization|credential|cookie/i;
const SECRET_VALUE = /\bsk-[a-zA-Z0-9_-]{8,}\b/g;

export function redactSensitive(value: unknown): unknown {
  if (typeof value === "string") {
    return value
      .replace(SECRET_VALUE, "[redacted]")
      .replace(/Bearer\s+\S+/gi, "Bearer [redacted]");
  }
  if (Array.isArray(value)) {
    return value.map(redactSensitive);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, nested]) => [
        key,
        SENSITIVE_KEY.test(key) ? "[redacted]" : redactSensitive(nested),
      ]),
    );
  }
  return value;
}

export function debugLlm(event: string, fields?: Record<string, unknown>): void {
  if (process.env.DEBUG_LLM !== "true" && process.env.LOG_LEVEL !== "debug") {
    return;
  }
  const safe = fields ? redactSensitive(fields) : undefined;
  console.debug(`[llm] ${event}`, safe ?? "");
}

export function assertNonEmptyPrompt(prompt: string): void {
  if (typeof prompt !== "string" || prompt.trim().length === 0) {
    throw new LLMPromptError("prompt must be a non-empty string");
  }
}

function nullsToUndefined(value: unknown): unknown {
  if (value === null) {
    return undefined;
  }
  if (Array.isArray(value)) {
    return value.map(nullsToUndefined);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, nested]) => [
        key,
        nested === null ? undefined : nullsToUndefined(nested),
      ]),
    );
  }
  return value;
}

function parseAgainstSchema<T>(
  raw: string,
  schema: ZodSchema<T>,
): { ok: true; data: T } | { ok: false; issue: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, issue: `Malformed JSON: ${detail}` };
  }

  const result = schema.safeParse(nullsToUndefined(parsed));
  if (!result.success) {
    return { ok: false, issue: result.error.issues.map((issue) => issue.message).join("; ") };
  }
  return { ok: true, data: result.data };
}

async function completeWithTimeout(
  complete: StructuredComplete,
  args: StructuredCompleteArgs,
  timeoutMs: number,
): Promise<string> {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  args.signal.addEventListener("abort", onAbort);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new LLMTimeoutError(timeoutMs));
    }, timeoutMs);
  });

  const work = complete({ ...args, signal: controller.signal });
  work.catch(() => undefined);

  try {
    return await Promise.race([work, timeout]);
  } catch (err) {
    if (err instanceof LLMTimeoutError) {
      throw err;
    }
    if (controller.signal.aborted || args.signal.aborted) {
      throw new LLMTimeoutError(timeoutMs);
    }
    throw err;
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
    args.signal.removeEventListener("abort", onAbort);
  }
}

/**
 * Shared empty-prompt / timeout / parse / one-retry pipeline used by both
 * the real adapter and the deterministic mock.
 */
export async function generateStructuredWith<T>(
  input: GenerateStructuredInput<T>,
  complete: StructuredComplete,
): Promise<T> {
  assertNonEmptyPrompt(input.prompt);
  const timeoutMs = input.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS;
  const outer = new AbortController();

  debugLlm("generateStructured.start", {
    prompt: input.prompt,
    timeoutMs,
  });

  const firstRaw = await completeWithTimeout(
    complete,
    { prompt: input.prompt, attempt: 1, signal: outer.signal },
    timeoutMs,
  );
  const first = parseAgainstSchema(firstRaw, input.schema);
  if (first.ok) {
    debugLlm("generateStructured.ok", { attempt: 1 });
    return first.data;
  }

  debugLlm("generateStructured.retry", { issue: first.issue, rawOutput: firstRaw });

  const secondRaw = await completeWithTimeout(
    complete,
    {
      prompt: input.prompt,
      attempt: 2,
      signal: outer.signal,
      previousRaw: firstRaw,
      previousIssue: first.issue,
    },
    timeoutMs,
  );
  const second = parseAgainstSchema(secondRaw, input.schema);
  if (second.ok) {
    debugLlm("generateStructured.ok", { attempt: 2 });
    return second.data;
  }

  throw new LLMOutputError(
    "LLM output failed schema validation after one retry",
    secondRaw,
    second.issue,
  );
}

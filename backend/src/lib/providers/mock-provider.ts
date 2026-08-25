import type { GenerateStructuredInput, LLMProvider, StructuredCompleteArgs } from "../llm-provider";
import { generateStructuredWith, LLMOutputError } from "../llm-provider";

export type MockLLMProviderOptions = {
  /** Deterministic JSON payloads keyed by the exact prompt string. */
  fixtures?: Record<string, unknown>;
  /** Raw strings/objects returned per attempt (1-based) for retry tests. */
  rawByPrompt?: Record<string, unknown[]>;
  /** Prompts whose completion never resolves — for timeout tests. */
  hangPrompts?: string[];
};

function toRaw(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

export class MockLLMProvider implements LLMProvider {
  readonly completeCalls: StructuredCompleteArgs[] = [];
  private readonly fixtures: Record<string, unknown>;
  private readonly rawByPrompt: Record<string, unknown[]>;
  private readonly hangPrompts: Set<string>;

  constructor(options: MockLLMProviderOptions = {}) {
    this.fixtures = { ...(options.fixtures ?? {}) };
    this.rawByPrompt = { ...(options.rawByPrompt ?? {}) };
    this.hangPrompts = new Set(options.hangPrompts ?? []);
  }

  generateStructured<T>(input: GenerateStructuredInput<T>): Promise<T> {
    return generateStructuredWith(input, (args) => this.complete(args));
  }

  private complete(args: StructuredCompleteArgs): Promise<string> {
    this.completeCalls.push(args);

    if (this.hangPrompts.has(args.prompt)) {
      return new Promise(() => undefined);
    }

    const sequence = this.rawByPrompt[args.prompt];
    if (sequence && sequence.length > 0) {
      const index = Math.min(args.attempt, sequence.length) - 1;
      return Promise.resolve(toRaw(sequence[index]));
    }

    if (Object.prototype.hasOwnProperty.call(this.fixtures, args.prompt)) {
      return Promise.resolve(toRaw(this.fixtures[args.prompt]));
    }

    return Promise.reject(
      new LLMOutputError(
        `No mock fixture registered for prompt: ${JSON.stringify(args.prompt)}`,
        "",
        "NO_FIXTURE",
      ),
    );
  }
}

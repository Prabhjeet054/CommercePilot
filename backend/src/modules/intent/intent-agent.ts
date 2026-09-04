import type { LLMProvider } from "../../lib/llm-provider";
import {
  LLMOutputError,
  LLMPromptError,
  LLMTimeoutError,
} from "../../lib/llm-provider";
import { getLLMProvider } from "../../lib/get-llm-provider";
import {
  IntentExtractionError,
  IntentPromptError,
  llmIntentSchema,
  toStructuredIntent,
  type StructuredIntent,
} from "./intent.schema";
import { buildIntentPrompt } from "./intent-prompt";

export { buildIntentPrompt, DEMO_INTENT_PHRASE, INJECTION_ATTEMPT_PHRASE } from "./intent-prompt";

const MAX_RAW_TEXT_CHARS = 4000;

function wrapProviderError(err: unknown): never {
  if (err instanceof IntentPromptError || err instanceof IntentExtractionError) {
    throw err;
  }
  if (err instanceof LLMPromptError) {
    throw new IntentPromptError(err.message);
  }
  if (err instanceof LLMOutputError || err instanceof LLMTimeoutError) {
    throw new IntentExtractionError(err.message, err);
  }
  throw err;
}

/**
 * Converts a free-text shopping goal into a schema-valid StructuredIntent.
 * purchaseMode on the result is advisory data only — it cannot authorize a
 * payment; only the Policy Engine can.
 */
export async function extractIntent(
  rawText: string,
  provider: LLMProvider = getLLMProvider(),
): Promise<StructuredIntent> {
  if (typeof rawText !== "string" || rawText.trim().length === 0) {
    throw new IntentPromptError("Shopping goal text is required");
  }
  if (rawText.trim().length > MAX_RAW_TEXT_CHARS) {
    throw new IntentPromptError(`Shopping goal text must be at most ${MAX_RAW_TEXT_CHARS} characters`);
  }

  const prompt = buildIntentPrompt(rawText.trim());

  let extracted;
  try {
    extracted = await provider.generateStructured({
      prompt,
      schema: llmIntentSchema,
    });
  } catch (err) {
    wrapProviderError(err);
  }

  return toStructuredIntent(extracted, rawText.trim());
}

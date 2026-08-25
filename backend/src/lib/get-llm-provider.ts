import { loadEnv, type Env } from "../config/env";
import type { LLMProvider } from "./llm-provider";
import { MockLLMProvider } from "./providers/mock-provider";
import { RealLLMProvider } from "./providers/real-provider";

export type LLMEnv = Pick<Env, "NODE_ENV" | "LLM_PROVIDER" | "LLM_PROVIDER_API_KEY">;

let override: LLMProvider | null = null;
let cached: LLMProvider | null = null;

export function shouldUseMockProvider(env: LLMEnv): boolean {
  if (env.NODE_ENV === "test") {
    return true;
  }
  return env.LLM_PROVIDER?.trim().toLowerCase() === "mock";
}

export function createLLMProvider(env: LLMEnv): LLMProvider {
  if (shouldUseMockProvider(env)) {
    return new MockLLMProvider();
  }
  return RealLLMProvider.fromEnv(env);
}

/**
 * Process-wide provider. Tests always get the mock (NODE_ENV=test), even if
 * `.env` points at a live vendor, so the suite cannot spend tokens by accident.
 */
export function getLLMProvider(): LLMProvider {
  if (override) {
    return override;
  }
  if (!cached) {
    cached = createLLMProvider(loadEnv());
  }
  return cached;
}

/** Test seam: inject a fixture-backed mock. Pass null to restore factory selection. */
export function setLLMProviderForTests(provider: LLMProvider | null): void {
  override = provider;
  cached = null;
}

/**
 * Manual smoke test for the Intent Agent against the live OpenAI adapter.
 *
 *   cd backend && npm run intent:smoke
 *
 * Requires LLM_PROVIDER_API_KEY in .env (not "replace-me").
 * Never invoked by `npm test`.
 */
import { loadEnv } from "../src/config/env";
import { RealLLMProvider } from "../src/lib/providers/real-provider";
import { DEMO_INTENT_PHRASE, extractIntent } from "../src/modules/intent/intent-agent";

async function main(): Promise<void> {
  const env = loadEnv();
  const provider = RealLLMProvider.fromEnv(env);
  const result = await extractIntent(DEMO_INTENT_PHRASE, provider);
  if (result.budget !== 5000) {
    throw new Error(`Expected budget 5000, received ${result.budget}`);
  }
  if (result.purchaseMode !== "autonomous") {
    throw new Error(`Expected purchaseMode autonomous, received ${result.purchaseMode}`);
  }
  if (result.category !== "Sports" && result.extractedCategory.toLowerCase().includes("run") === false) {
    throw new Error(`Expected Sports / running-shoes category, received ${result.category}`);
  }
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

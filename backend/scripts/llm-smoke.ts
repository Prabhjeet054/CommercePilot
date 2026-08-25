/**
 * Manual smoke test for the real OpenAI adapter.
 *
 *   cd backend && npm run llm:smoke
 *
 * Requires LLM_PROVIDER_API_KEY in .env (not "replace-me").
 * Never invoked by `npm test`.
 */
import { z } from "zod";
import { loadEnv } from "../src/config/env";
import { RealLLMProvider } from "../src/lib/providers/real-provider";

async function main(): Promise<void> {
  const env = loadEnv();
  const provider = RealLLMProvider.fromEnv(env);
  const schema = z.object({
    ok: z.boolean(),
    greeting: z.string(),
  });

  const result = await provider.generateStructured({
    prompt: 'Return JSON with ok=true and greeting="hello".',
    schema,
    timeoutMs: 30_000,
  });

  schema.parse(result);
  console.log(JSON.stringify(result));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

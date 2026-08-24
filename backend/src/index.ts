import { createApp } from "./app";
import { EnvValidationError, loadEnv } from "./config/env";

function start(): void {
  let env;
  try {
    env = loadEnv();
  } catch (err) {
    if (err instanceof EnvValidationError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }

  const app = createApp(env);

  app.listen(env.PORT, () => {
    console.log(`CommercePilot API listening on port ${env.PORT}`);
  });
}

start();

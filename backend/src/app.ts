import cookieParser from "cookie-parser";
import cors from "cors";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { isAllowedFrontendOrigin } from "./lib/cors-origin";
import type { Env } from "./config/env";
import { LLMConfigError } from "./lib/llm-provider";
import { createApprovalRouter } from "./modules/approvals/approval.routes";
import { createAuthRouter } from "./modules/auth/auth.routes";
import { createCatalogRouter } from "./modules/catalog/catalog.routes";
import { createOrchestratorRouter } from "./modules/orchestrator/orchestrator.routes";
import { createPaymentsRouter } from "./modules/payments/payments.routes";
import { createPolicyRouter } from "./modules/policy/policy.routes";

export type AppConfig = Pick<
  Env,
  "FRONTEND_URL" | "JWT_SECRET" | "JWT_REFRESH_SECRET" | "NODE_ENV" | "COOKIE_SECURE"
>;

export function createApp(config: AppConfig): Express {
  const app = express();
  app.set("trust proxy", 1);
  app.locals.jwtSecret = config.JWT_SECRET;
  app.locals.jwtRefreshSecret = config.JWT_REFRESH_SECRET;
  app.locals.cookieSecure =
    config.COOKIE_SECURE === "true" ||
    (config.COOKIE_SECURE !== "false" && config.NODE_ENV === "production");

  app.use(
    cors({
      origin: (requestOrigin, callback) => {
        if (isAllowedFrontendOrigin(requestOrigin, config.FRONTEND_URL)) {
          callback(null, true);
          return;
        }
        callback(null, false);
      },
      credentials: true,
    }),
  );
  app.use(express.json({ limit: "32kb" }));
  app.use(cookieParser());

  app.get("/health", (_req, res) => {
    res.status(200).json({
      status: "ok",
      timestamp: new Date().toISOString(),
    });
  });

  app.use("/auth", createAuthRouter());
  app.use(createCatalogRouter());
  app.use(createPolicyRouter());
  app.use(createOrchestratorRouter());
  app.use(createApprovalRouter());
  app.use(createPaymentsRouter());

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof LLMConfigError) {
      console.error(`LLM config error: ${err.message}`);
      res.status(503).json({
        error: "LLM_NOT_CONFIGURED",
        message:
          "AI is not configured. Set a real LLM_PROVIDER_API_KEY in .env, or set LLM_PROVIDER=mock for local demo phrases.",
      });
      return;
    }
    const message = err instanceof Error ? err.message : "Internal error";
    console.error(`Unhandled error: ${message}`);
    res.status(500).json({ error: "INTERNAL_ERROR" });
  });

  return app;
}

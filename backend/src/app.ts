import cors from "cors";
import express, { type Express } from "express";

export type AppConfig = {
  FRONTEND_URL: string;
};

export function createApp(config: AppConfig): Express {
  const app = express();

  app.use(
    cors({
      origin: (requestOrigin, callback) => {
        if (!requestOrigin || requestOrigin === config.FRONTEND_URL) {
          callback(null, true);
          return;
        }
        callback(null, false);
      },
    }),
  );

  app.get("/health", (_req, res) => {
    res.status(200).json({
      status: "ok",
      timestamp: new Date().toISOString(),
    });
  });

  return app;
}

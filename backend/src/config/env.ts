import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import { z } from "zod";

function loadDotenvFile(): void {
  const candidates = [
    path.resolve(process.cwd(), ".env"),
    path.resolve(process.cwd(), "../.env"),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      dotenv.config({ path: candidate });
      return;
    }
  }

  dotenv.config();
}

loadDotenvFile();

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z
    .string({ required_error: "DATABASE_URL is required" })
    .min(1, "DATABASE_URL is required"),
  FRONTEND_URL: z
    .string({ required_error: "FRONTEND_URL is required" })
    .url("FRONTEND_URL must be a valid URL"),
  LLM_PROVIDER: z.string().optional(),
  LLM_PROVIDER_API_KEY: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

export class EnvValidationError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    const body = issues.map((issue) => `  - ${issue}`).join("\n");
    super(
      `EnvValidationError: missing or invalid environment variables:\n${body}\nCopy .env.example to .env and set the required values.`,
    );
    this.name = "EnvValidationError";
    this.issues = issues;
  }
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);

  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => {
      const key = issue.path.join(".") || "(root)";
      return `${key}: ${issue.message}`;
    });
    throw new EnvValidationError(issues);
  }

  return parsed.data;
}

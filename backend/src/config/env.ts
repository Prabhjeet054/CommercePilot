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
  JWT_SECRET: z
    .string({ required_error: "JWT_SECRET is required" })
    .min(16, "JWT_SECRET must be at least 16 characters"),
  JWT_REFRESH_SECRET: z
    .string({ required_error: "JWT_REFRESH_SECRET is required" })
    .min(16, "JWT_REFRESH_SECRET must be at least 16 characters"),
  COOKIE_SECURE: z.enum(["true", "false"]).optional(),
  // Consumed by getLLMProvider(); "openai" is the real adapter, "mock" forces the test double.
  LLM_PROVIDER: z.string().optional(),
  LLM_PROVIDER_API_KEY: z.string().optional(),
  APPROVAL_TTL_MINUTES: z.coerce.number().int().positive().max(24 * 60).default(15),
  // Test-mode placeholders in .env.example only. Secret is backend-only.
  RAZORPAY_KEY_ID: z.string().optional(),
  RAZORPAY_KEY_SECRET: z.string().optional(),
  // Distinct from KEY_SECRET — configured on the Razorpay webhook endpoint.
  RAZORPAY_WEBHOOK_SECRET: z.string().optional(),
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

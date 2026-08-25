/**
 * Suite-wide safety net: tests must never call a live LLM vendor, and
 * LLM API key values must never appear in console output.
 */
import { afterAll, beforeAll } from "vitest";

const LLM_HOST = /(?:^https?:\/\/)?(?:[\w.-]+\.)?(?:openai\.com|anthropic\.com)(?:\/|$)/i;

const consoleLines: string[] = [];
const blockedUrls: string[] = [];
const originals = {
  debug: console.debug.bind(console),
  info: console.info.bind(console),
  log: console.log.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
};

const TEST_SECRETS = [
  "sk-should-never-be-used",
  "sk-test-not-a-real-key",
  "sk-secret-test-key-do-not-leak",
];

function lineFromArgs(args: unknown[]): string {
  return args
    .map((value) => (typeof value === "string" ? value : safeJson(value)))
    .join(" ");
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function record(level: keyof typeof originals, args: unknown[]): void {
  consoleLines.push(lineFromArgs(args));
  originals[level](...args);
}

export function capturedLogText(): string {
  return consoleLines.join("\n");
}

export function blockedLlmUrls(): string[] {
  return [...blockedUrls];
}

beforeAll(() => {
  console.debug = (...args: unknown[]) => record("debug", args);
  console.info = (...args: unknown[]) => record("info", args);
  console.log = (...args: unknown[]) => record("log", args);
  console.warn = (...args: unknown[]) => record("warn", args);
  console.error = (...args: unknown[]) => record("error", args);

  const originalFetch = globalThis.fetch;
  if (typeof originalFetch !== "function") {
    return;
  }

  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    if (LLM_HOST.test(url)) {
      blockedUrls.push(url);
      throw new Error(`Live LLM network call blocked in tests: ${url}`);
    }
    return originalFetch(input, init);
  }) as typeof fetch;
});

afterAll(() => {
  console.debug = originals.debug;
  console.info = originals.info;
  console.log = originals.log;
  console.warn = originals.warn;
  console.error = originals.error;

  if (blockedUrls.length > 0) {
    throw new Error(
      `Test suite attempted live LLM network calls: ${blockedUrls.join(", ")}`,
    );
  }

  const dump = consoleLines.join("\n");
  const envKey = process.env.LLM_PROVIDER_API_KEY?.trim();
  const secrets = [...TEST_SECRETS];
  if (envKey && envKey !== "replace-me") {
    secrets.push(envKey);
  }

  const leaked = secrets.filter((secret) => secret.length > 0 && dump.includes(secret));
  if (leaked.length > 0) {
    throw new Error(`API key value appeared in a log line during the test run: ${leaked[0]}`);
  }
});

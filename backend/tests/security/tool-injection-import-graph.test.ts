import { readdirSync, readFileSync, statSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

/**
 * PRD §23 — Unauthorized tool execution / tool injection:
 * LLM-touching modules must not import Payment, Approval, or Orders write paths.
 */

const PAYMENTS_IMPORT =
  /(?:from|require\()\s*['"][^'"]*modules\/payments(?:\/[^'"]*)?['"]/;

function sourceImportsPayments(source: string): boolean {
  return PAYMENTS_IMPORT.test(source);
}

const SRC = path.resolve(__dirname, "../../src");
const INTENT_DIR = path.join(SRC, "modules/intent");
const RANKING_DIR = path.join(SRC, "modules/ranking");
const LLM_DIRS = [
  INTENT_DIR,
  RANKING_DIR,
  path.join(SRC, "lib/providers"),
  path.join(SRC, "lib/llm-provider.ts"),
];

const FORBIDDEN = [
  /modules\/payments(?:\/|'|")/,
  /modules\/approvals(?:\/|'|")/,
  /modules\/orders(?:\/|'|")/,
  /prisma\.order\.create/,
  /createRazorpayOrder/,
  /decideApproval/,
  /applyOrderLifecycleEvent/,
];

function listTsFiles(entry: string): string[] {
  const stat = statSync(entry);
  if (stat.isFile()) {
    return entry.endsWith(".ts") ? [entry] : [];
  }
  const out: string[] = [];
  for (const child of readdirSync(entry)) {
    out.push(...listTsFiles(path.join(entry, child)));
  }
  return out;
}

function llmTouchingSources(): string[] {
  return LLM_DIRS.flatMap(listTsFiles);
}

describe("security: tool-injection import graph", () => {
  it("extends Phase 10: intent/ranking never import payments", () => {
    const files = [...listTsFiles(INTENT_DIR), ...listTsFiles(RANKING_DIR)];
    for (const file of files) {
      expect(sourceImportsPayments(readFileSync(file, "utf8")), file).toBe(false);
    }
  });

  it("LLM-touching modules have no import/call path into payments, approvals, or order writes", () => {
    const violations: string[] = [];
    for (const file of llmTouchingSources()) {
      const source = readFileSync(file, "utf8");
      for (const pattern of FORBIDDEN) {
        if (pattern.test(source)) {
          violations.push(`${path.relative(SRC, file)} matches ${pattern}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("orchestrator may coordinate policy/approvals but still never imports payments or creates orders", () => {
    const orchestratorDir = path.join(SRC, "modules/orchestrator");
    const sources = listTsFiles(orchestratorDir)
      .map((file) => readFileSync(file, "utf8"))
      .join("\n");
    expect(sources).not.toMatch(/modules\/payments/);
    expect(sources).not.toMatch(/prisma\.order\.create/);
    expect(sources).not.toMatch(/createRazorpayOrder/);
  });
});

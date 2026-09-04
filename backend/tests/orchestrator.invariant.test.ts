import { readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

const PAYMENTS_IMPORT =
  /(?:from|require\()\s*['"][^'"]*modules\/payments(?:\/[^'"]*)?['"]/;

export function sourceImportsPayments(source: string): boolean {
  return PAYMENTS_IMPORT.test(source);
}

function listTsFiles(dir: string): string[] {
  const entries = readdirSync(dir);
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      files.push(...listTsFiles(full));
      continue;
    }
    if (entry.endsWith(".ts")) {
      files.push(full);
    }
  }
  return files;
}

const INTENT_DIR = path.resolve(__dirname, "../src/modules/intent");
const RANKING_DIR = path.resolve(__dirname, "../src/modules/ranking");
const BACKEND_ROOT = path.resolve(__dirname, "..");

function paymentsImportViolations(): string[] {
  const files = [...listTsFiles(INTENT_DIR), ...listTsFiles(RANKING_DIR)];
  const violations: string[] = [];
  for (const file of files) {
    if (sourceImportsPayments(readFileSync(file, "utf8"))) {
      violations.push(path.relative(BACKEND_ROOT, file));
    }
  }
  return violations;
}

describe("no-cross-import invariant (PRD Section 13)", () => {
  it("detects a payments import the way a future violating file would", () => {
    expect(sourceImportsPayments('import { createOrder } from "../../modules/payments/create-order";')).toBe(
      true,
    );
    expect(sourceImportsPayments('const x = require("../modules/payments/razorpay-client");')).toBe(true);
    expect(sourceImportsPayments('import { extractIntent } from "../intent/intent-agent";')).toBe(false);
    expect(sourceImportsPayments('import { rankProducts } from "../ranking/rank";')).toBe(false);
  });

  it("fails when a dummy payments import is added under intent/, then is clean after removal", () => {
    const dummy = path.join(INTENT_DIR, "__payments-import-probe.ts");
    try {
      writeFileSync(dummy, 'import { createOrder } from "../../modules/payments/create-order";\n');
      const caught = paymentsImportViolations();
      expect(caught.some((file) => file.endsWith("__payments-import-probe.ts"))).toBe(true);
    } finally {
      try {
        unlinkSync(dummy);
      } catch {
        // probe file already removed
      }
    }

    expect(paymentsImportViolations()).toEqual([]);
  });

  it("intent and ranking modules never import modules/payments", () => {
    expect(listTsFiles(INTENT_DIR).length + listTsFiles(RANKING_DIR).length).toBeGreaterThan(0);
    expect(paymentsImportViolations()).toEqual([]);
  });

  it("orchestrator never creates an Order (Phase 13/15)", () => {
    const orchestratorDir = path.resolve(__dirname, "../src/modules/orchestrator");
    const sources = listTsFiles(orchestratorDir).map((file) => readFileSync(file, "utf8")).join("\n");
    expect(sources).not.toMatch(/prisma\.order\.create/);
    expect(sources).not.toMatch(/modules\/payments/);
  });
});

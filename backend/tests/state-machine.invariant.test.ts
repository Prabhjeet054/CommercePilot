import { readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

const SRC_ROOT = path.resolve(__dirname, "../src");
const BACKEND_ROOT = path.resolve(__dirname, "..");

const INTENT_STATUS_ALLOW = new Set([path.normalize("src/lib/state-machine.ts")]);
const ORDER_STATE_ALLOW = new Set([path.normalize("src/modules/orders/order.service.ts")]);

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

function rel(file: string): string {
  return path.relative(BACKEND_ROOT, file);
}

export function hasDirectPurchaseIntentStatusWrite(source: string): boolean {
  const re = /purchaseIntent\.(update|updateMany)\s*\(/g;
  let match = re.exec(source);
  while (match) {
    const slice = source.slice(match.index, match.index + 900);
    const data = slice.match(/\bdata\s*:\s*\{([^}]*)\}/);
    if (data && /\bstatus\s*:/.test(data[1])) {
      return true;
    }
    match = re.exec(source);
  }
  return false;
}

export function hasDirectOrderStateWrite(source: string): boolean {
  const re = /\.order\.(create|update|updateMany)\s*\(/g;
  let match = re.exec(source);
  while (match) {
    const slice = source.slice(match.index, match.index + 900);
    const data = slice.match(/\bdata\s*:\s*\{([^}]*)\}/);
    if (data && /\bstate\s*:/.test(data[1])) {
      return true;
    }
    match = re.exec(source);
  }
  return false;
}

function intentStatusViolations(): string[] {
  const violations: string[] = [];
  for (const file of listTsFiles(SRC_ROOT)) {
    const relative = rel(file);
    if (INTENT_STATUS_ALLOW.has(path.normalize(relative))) {
      continue;
    }
    if (hasDirectPurchaseIntentStatusWrite(readFileSync(file, "utf8"))) {
      violations.push(relative);
    }
  }
  return violations;
}

function orderStateViolations(): string[] {
  const violations: string[] = [];
  for (const file of listTsFiles(SRC_ROOT)) {
    const relative = rel(file);
    if (ORDER_STATE_ALLOW.has(path.normalize(relative))) {
      continue;
    }
    if (hasDirectOrderStateWrite(readFileSync(file, "utf8"))) {
      violations.push(relative);
    }
  }
  return violations;
}

describe("no direct purchase-intent/order state writes outside designated services", () => {
  it("detects a direct purchaseIntent status update the way a future violating file would", () => {
    expect(
      hasDirectPurchaseIntentStatusWrite(
        `await prisma.purchaseIntent.update({ where: { id }, data: { status: "APPROVED" } });`,
      ),
    ).toBe(true);
    expect(
      hasDirectPurchaseIntentStatusWrite(
        `await prisma.purchaseIntent.update({ where: { id }, data: { purchaseMode: "manual" } });`,
      ),
    ).toBe(false);
  });

  it("fails when a dummy status write is added under orchestrator/, then is clean after removal", () => {
    const dummy = path.resolve(SRC_ROOT, "modules/orchestrator/__state-write-probe.ts");
    try {
      writeFileSync(
        dummy,
        `export async function probe(prisma: { purchaseIntent: { update: Function } }, id: string) {
  await prisma.purchaseIntent.update({ where: { id }, data: { status: "COMPLETED" } });
}
`,
      );
      expect(intentStatusViolations().some((file) => file.endsWith("__state-write-probe.ts"))).toBe(true);
    } finally {
      try {
        unlinkSync(dummy);
      } catch {
        // probe file already removed
      }
    }
    expect(intentStatusViolations()).toEqual([]);
  });

  it("application src never writes purchase_intents.status outside state-machine.ts", () => {
    expect(intentStatusViolations()).toEqual([]);
  });

  it("application src never writes orders.state outside order.service.ts", () => {
    expect(orderStateViolations()).toEqual([]);
  });
});

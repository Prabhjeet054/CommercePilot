import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

/**
 * Append-only guarantee: production code may only create/read AuditLog rows.
 * Test teardowns may deleteMany for isolation — those paths are allowlisted.
 */
describe("AuditLog append-only surface", () => {
  it("has no update/delete/upsert on AuditLog outside test teardown", () => {
    const root = path.resolve(__dirname, "../src");
    const offenders: string[] = [];

    function walk(dir: string): void {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.name.endsWith(".ts")) {
          continue;
        }
        const text = fs.readFileSync(full, "utf8");
        const patterns = [
          /auditLog\.update\b/,
          /auditLog\.updateMany\b/,
          /auditLog\.delete\b/,
          /auditLog\.deleteMany\b/,
          /auditLog\.upsert\b/,
        ];
        for (const pattern of patterns) {
          if (pattern.test(text)) {
            offenders.push(`${path.relative(root, full)}: ${pattern}`);
          }
        }
      }
    }

    walk(root);
    expect(offenders).toEqual([]);
  });
});

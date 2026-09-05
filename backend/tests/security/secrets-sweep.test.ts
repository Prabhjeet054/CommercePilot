import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import { execFileSync } from "child_process";

/**
 * PRD §22 Secrets — re-scan current frontend build + backend sources for secret leakage.
 * Complements payments.secret-leak.test.ts with a Phase 24 consolidation pass.
 */

const REPO_ROOT = path.resolve(__dirname, "../../..");
const FRONTEND_ROOT = path.join(REPO_ROOT, "frontend");
const BACKEND_SRC = path.join(REPO_ROOT, "backend/src");

const SECRET_NEEDLES = [
  "RAZORPAY_KEY_SECRET",
  "RAZORPAY_WEBHOOK_SECRET",
  "JWT_SECRET",
  "JWT_REFRESH_SECRET",
  "DATABASE_URL",
];

function walkFiles(dir: string, pred: (name: string) => boolean): string[] {
  if (!fs.existsSync(dir)) {
    return [];
  }
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".git") {
        continue;
      }
      out.push(...walkFiles(full, pred));
    } else if (pred(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

describe("security: secrets sweep", () => {
  it("frontend source never embeds Razorpay key secret / webhook secret / JWT secrets", () => {
    const files = walkFiles(path.join(FRONTEND_ROOT, "src"), (name) =>
      /\.(ts|tsx|js|jsx|css|html)$/.test(name),
    );
    const leaks: string[] = [];
    for (const file of files) {
      const text = fs.readFileSync(file, "utf8");
      for (const needle of SECRET_NEEDLES) {
        if (text.includes(needle)) {
          leaks.push(`${path.relative(REPO_ROOT, file)} contains ${needle}`);
        }
      }
    }
    expect(leaks).toEqual([]);
  });

  it("backend API modules do not return secret env values in string literals of error payloads", () => {
    const files = walkFiles(BACKEND_SRC, (name) => name.endsWith(".ts"));
    const leaks: string[] = [];
    for (const file of files) {
      const text = fs.readFileSync(file, "utf8");
      // Hard fail if a response JSON template interpolates process.env secret keys.
      if (/res\.(status|json).*process\.env\.(RAZORPAY_KEY_SECRET|RAZORPAY_WEBHOOK_SECRET|JWT_SECRET)/s.test(text)) {
        leaks.push(path.relative(REPO_ROOT, file));
      }
    }
    expect(leaks).toEqual([]);
  });

  it("production frontend build assets do not inline backend secret values", () => {
    const distAssets = path.join(FRONTEND_ROOT, "dist/assets");
    if (!fs.existsSync(distAssets)) {
      execFileSync("npm", ["run", "build"], {
        cwd: FRONTEND_ROOT,
        env: {
          ...process.env,
          VITE_API_URL: "http://localhost:3000",
          // decoys that must never appear inlined
          RAZORPAY_KEY_SECRET: "replace-me-must-not-leak-into-vite",
          JWT_SECRET: "phase3-dev-access-secret-change-me",
        },
        stdio: "pipe",
      });
    }

    const assets = walkFiles(path.join(FRONTEND_ROOT, "dist"), (name) =>
      /\.(js|css|html|map)$/.test(name),
    );
    expect(assets.length).toBeGreaterThan(0);

    const decoys = [
      "replace-me-must-not-leak-into-vite",
      "phase3-dev-access-secret-change-me",
      "RAZORPAY_KEY_SECRET",
      "RAZORPAY_WEBHOOK_SECRET",
      "JWT_SECRET",
      "JWT_REFRESH_SECRET",
      "DATABASE_URL",
    ];
    const leaked: string[] = [];
    for (const file of assets) {
      const text = fs.readFileSync(file, "utf8");
      for (const decoy of decoys) {
        if (text.includes(decoy)) {
          leaked.push(`${path.relative(REPO_ROOT, file)}: ${decoy}`);
        }
      }
    }
    expect(leaked).toEqual([]);
  });
});

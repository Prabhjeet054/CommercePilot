import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(__dirname, "../..");
const FRONTEND_ROOT = path.join(REPO_ROOT, "frontend");
const FRONTEND_DIST = path.join(FRONTEND_ROOT, "dist");

const SECRET_NEEDLES = ["RAZORPAY_KEY_SECRET", "JWT_SECRET", "JWT_REFRESH_SECRET", "DATABASE_URL"];
const TEXT_ASSET = /\.(js|css|html|json|map|txt|svg)$/i;

function gitTrackedFiles(): string[] {
  const output = execFileSync("git", ["ls-files"], { cwd: REPO_ROOT, encoding: "utf8" });
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function listFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) {
    return [];
  }
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listFiles(full));
    } else {
      out.push(full);
    }
  }
  return out;
}

function secretHitsInFile(file: string): string[] {
  const text = fs.readFileSync(file, "utf8");
  return SECRET_NEEDLES.filter((needle) => text.includes(needle));
}

describe("RAZORPAY_KEY_SECRET leak check", () => {
  it("never appears under /frontend (source or config)", () => {
    const leaked: string[] = [];
    for (const file of gitTrackedFiles()) {
      if (!file.startsWith("frontend/") || file.includes("node_modules/")) {
        continue;
      }
      const full = path.join(REPO_ROOT, file);
      if (!fs.existsSync(full) || fs.statSync(full).isDirectory()) {
        continue;
      }
      if (fs.readFileSync(full, "utf8").includes("RAZORPAY_KEY_SECRET")) {
        leaked.push(file);
      }
    }
    expect(leaked).toEqual([]);
  });

  it("git-tracked secret assignments are placeholders only", () => {
    const liveKey = /rzp_live_[A-Za-z0-9]{12,}/;
    const offenders: string[] = [];
    const placeholderFiles = [".env.example", "docker-compose.yml"];

    for (const file of placeholderFiles) {
      const full = path.join(REPO_ROOT, file);
      const text = fs.readFileSync(full, "utf8");
      const match = text.match(/RAZORPAY_KEY_SECRET\s*[:=]\s*["']?([^\s"']+)/);
      const value = match?.[1] ?? "";
      if (value !== "replace-me") {
        offenders.push(`${file}: expected replace-me, got ${value || "(missing)"}`);
      }
    }

    for (const file of gitTrackedFiles()) {
      if (file.endsWith(".md")) {
        continue;
      }
      const full = path.join(REPO_ROOT, file);
      if (!fs.existsSync(full) || fs.statSync(full).isDirectory()) {
        continue;
      }
      const text = fs.readFileSync(full, "utf8");
      if (liveKey.test(text)) {
        offenders.push(`${file}: rzp_live_ material`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it("production frontend build assets do not contain backend secrets", () => {
    execFileSync("npm", ["run", "build"], {
      cwd: FRONTEND_ROOT,
      stdio: "pipe",
      timeout: 120_000,
      env: {
        ...process.env,
        RAZORPAY_KEY_SECRET: "replace-me-must-not-leak-into-vite",
        JWT_SECRET: "jwt-must-not-leak-into-vite",
        JWT_REFRESH_SECRET: "refresh-must-not-leak-into-vite",
        DATABASE_URL: "postgresql://must-not-leak/commercepilot",
      },
    });

    expect(fs.existsSync(FRONTEND_DIST)).toBe(true);

    const leaked: string[] = [];
    for (const file of listFiles(FRONTEND_DIST)) {
      if (!TEXT_ASSET.test(file)) {
        continue;
      }
      const hits = secretHitsInFile(file);
      const text = fs.readFileSync(file, "utf8");
      if (hits.length > 0) {
        leaked.push(`${path.relative(REPO_ROOT, file)}: ${hits.join(", ")}`);
      }
      if (text.includes("replace-me-must-not-leak-into-vite")) {
        leaked.push(`${path.relative(REPO_ROOT, file)}: RAZORPAY_KEY_SECRET value inlined`);
      }
      if (text.includes("jwt-must-not-leak-into-vite") || text.includes("refresh-must-not-leak-into-vite")) {
        leaked.push(`${path.relative(REPO_ROOT, file)}: JWT secret inlined`);
      }
      if (text.includes("postgresql://must-not-leak")) {
        leaked.push(`${path.relative(REPO_ROOT, file)}: DATABASE_URL inlined`);
      }
    }

    expect(leaked).toEqual([]);
  }, 180_000);
});

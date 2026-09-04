import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(__dirname, "../..");

function gitTrackedFiles(): string[] {
  const output = execFileSync("git", ["ls-files"], { cwd: REPO_ROOT, encoding: "utf8" });
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
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
});

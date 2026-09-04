import { execSync } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

export default function globalSetup(): void {
  const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../backend");
  execSync("npx prisma db seed", {
    cwd: backendRoot,
    stdio: "inherit",
    env: process.env,
  });
}

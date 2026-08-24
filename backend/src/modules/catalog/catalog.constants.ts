import { createHash } from "crypto";

const SEED_NAMESPACE = "commercepilot-seed-v1";

/** Deterministic UUID v5-style id so the seed can upsert by a stable key. */
export function seedUuid(key: string): string {
  const hash = createHash("sha1").update(`${SEED_NAMESPACE}:${key}`).digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export const DEMO_SHOE_PRODUCT_KEY = "product:apex-stride-runner";
export const DEMO_LAPTOP_PRODUCT_KEY = "product:nova-ultrabook-16";

export const DEMO_SHOE_PRODUCT_ID = seedUuid(DEMO_SHOE_PRODUCT_KEY);
export const DEMO_LAPTOP_PRODUCT_ID = seedUuid(DEMO_LAPTOP_PRODUCT_KEY);

export const DEMO_SHOE_PRICE = "4499.00";
export const DEMO_LAPTOP_PRICE = "120000.00";

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 100;

-- Link merchant_admin users to a single merchant (Phase 4 ownership).
-- Multiple NULLs are allowed; a non-null merchant_id is unique (one admin per merchant).

ALTER TABLE "users" ADD COLUMN "merchant_id" UUID;

CREATE UNIQUE INDEX "users_merchant_id_key" ON "users"("merchant_id");

ALTER TABLE "users" ADD CONSTRAINT "users_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

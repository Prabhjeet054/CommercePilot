import { z } from "zod";

export const createOrderBodySchema = z
  .object({
    purchaseIntentId: z.string().uuid(),
  })
  .strip();

export type CreateOrderBody = z.infer<typeof createOrderBodySchema>;

/** Checkout handler fields — Phase 17 verifies the signature server-side. */
export const verifyPaymentBodySchema = z
  .object({
    razorpay_order_id: z.string().min(1),
    razorpay_payment_id: z.string().min(1),
    razorpay_signature: z.string().min(1),
  })
  .strip();

export type VerifyPaymentBody = z.infer<typeof verifyPaymentBodySchema>;

export function fieldErrors(error: z.ZodError): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.map(String).join(".") || "body";
    if (!fields[key]) {
      fields[key] = issue.message;
    }
  }
  return fields;
}

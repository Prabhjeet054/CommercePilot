import { z } from "zod";
import { PURCHASE_MODES } from "../intent/intent.schema";

export const createPurchaseIntentSchema = z.object({
  text: z.string().trim().min(1, "Shopping goal text is required").max(4000),
  purchaseMode: z.enum(PURCHASE_MODES, {
    errorMap: () => ({ message: "purchaseMode must be autonomous or manual" }),
  }),
});

export const purchaseIntentIdParamSchema = z.string().uuid();

export type CreatePurchaseIntentBody = z.infer<typeof createPurchaseIntentSchema>;

export function fieldErrors(error: z.ZodError): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".") || "_root";
    if (!fields[key]) {
      fields[key] = issue.message;
    }
  }
  return fields;
}

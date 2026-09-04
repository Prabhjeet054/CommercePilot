import { z } from "zod";

export const createOrderBodySchema = z
  .object({
    purchaseIntentId: z.string().uuid(),
  })
  .strip();

export type CreateOrderBody = z.infer<typeof createOrderBodySchema>;

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

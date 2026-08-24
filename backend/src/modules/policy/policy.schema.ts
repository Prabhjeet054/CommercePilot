import { z } from "zod";

const emptyToUndefined = (value: unknown) => {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  return value;
};

/**
 * Monetary caps are independent numeric fields. Phase 5's evaluatePolicy
 * branch order already handles their interaction (e.g. a high
 * maxAutonomousAmount does not bypass a lower approvalThreshold). This
 * schema therefore does NOT require approvalThreshold <= maxAutonomousAmount
 * or dailySpendingLimit >= either of them.
 */
const nonNegativeMoney = z.preprocess(
  emptyToUndefined,
  z.coerce
    .number({ invalid_type_error: "Must be a number", required_error: "Required" })
    .finite("Must be a number")
    .nonnegative("Must be non-negative"),
);

const stringList = z.array(z.string().trim().min(1).max(80)).max(50).default([]);

export const policyWriteSchema = z.object({
  maxAutonomousAmount: nonNegativeMoney,
  dailySpendingLimit: nonNegativeMoney,
  approvalThreshold: nonNegativeMoney,
  allowedCategories: stringList,
  blockedCategories: stringList,
  trustedMerchants: z.array(z.string().uuid("trustedMerchants must be UUIDs")).max(50).default([]),
  autonomousEnabled: z.boolean().default(false),
  maxAutonomousTxnsPerDay: z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().nonnegative().max(100).default(3),
  ),
});

export type PolicyWriteBody = z.infer<typeof policyWriteSchema>;

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

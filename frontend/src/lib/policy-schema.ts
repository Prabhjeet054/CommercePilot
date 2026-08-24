import { z } from "zod";

const emptyToUndefined = (value: unknown) => {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  return value;
};

const nonNegativeMoney = z.preprocess(
  emptyToUndefined,
  z.coerce
    .number({ invalid_type_error: "Must be a number", required_error: "Required" })
    .finite("Must be a number")
    .nonnegative("Must be non-negative"),
);

export const policyWriteSchema = z.object({
  maxAutonomousAmount: nonNegativeMoney,
  dailySpendingLimit: nonNegativeMoney,
  approvalThreshold: nonNegativeMoney,
  allowedCategories: z.array(z.string().trim().min(1).max(80)).max(50),
  blockedCategories: z.array(z.string().trim().min(1).max(80)).max(50),
  trustedMerchants: z.string().optional(),
  autonomousEnabled: z.boolean(),
  maxAutonomousTxnsPerDay: z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().nonnegative().max(100),
  ),
});

export type PolicyFormInput = {
  maxAutonomousAmount: number;
  dailySpendingLimit: number;
  approvalThreshold: number;
  allowedCategories: string[];
  blockedCategories: string[];
  trustedMerchants: string;
  autonomousEnabled: boolean;
  maxAutonomousTxnsPerDay: number;
};

export const DEMO_POLICY_DEFAULTS: PolicyFormInput = {
  maxAutonomousAmount: 5000,
  dailySpendingLimit: 10000,
  approvalThreshold: 5000,
  allowedCategories: ["Electronics", "Sports", "Travel"],
  blockedCategories: [],
  trustedMerchants: "",
  autonomousEnabled: true,
  maxAutonomousTxnsPerDay: 3,
};

export function parseTrustedMerchants(raw: string): string[] {
  return raw
    .split(/[,\s]+/)
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

export function formatInr(amount: number): string {
  return amount.toLocaleString("en-IN", { maximumFractionDigits: 2 });
}

export function summarizePolicy(policy: {
  maxAutonomousAmount: number;
  dailySpendingLimit: number;
  approvalThreshold: number;
  allowedCategories: string[];
  blockedCategories: string[];
  autonomousEnabled: boolean;
  maxAutonomousTxnsPerDay: number;
}): string {
  if (!policy.autonomousEnabled) {
    return "Autonomous purchasing is turned off. Every purchase will need your approval.";
  }

  const parts = [
    `Autonomous purchases up to ₹${formatInr(policy.maxAutonomousAmount)} are allowed automatically; anything above ₹${formatInr(policy.approvalThreshold)} will need your approval.`,
    `Daily spending is capped at ₹${formatInr(policy.dailySpendingLimit)}.`,
    `At most ${policy.maxAutonomousTxnsPerDay} autonomous purchase${policy.maxAutonomousTxnsPerDay === 1 ? "" : "s"} per day.`,
  ];

  if (policy.allowedCategories.length > 0) {
    parts.push(`Allowed categories: ${policy.allowedCategories.join(", ")}.`);
  } else {
    parts.push("No allow-list restriction is set.");
  }

  if (policy.blockedCategories.length > 0) {
    parts.push(`Blocked categories: ${policy.blockedCategories.join(", ")}.`);
  }

  return parts.join(" ");
}

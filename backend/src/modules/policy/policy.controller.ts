import type { Request, Response } from "express";
import { REASON } from "./evaluate";
import { fieldErrors, policyWriteSchema } from "./policy.schema";
import { getPolicyForUser, serializePolicy, upsertPolicyForUser } from "./policy.service";

export async function getMine(req: Request, res: Response): Promise<void> {
  const userId = req.user?.id;
  if (!userId) {
    res.status(401).json({ error: "UNAUTHORIZED" });
    return;
  }

  const policy = await getPolicyForUser(userId);
  if (!policy) {
    res.status(404).json({
      error: REASON.NO_POLICY_CONFIGURED,
      message: "No financial policy is configured yet. Set up your policy to enable autonomous purchasing.",
    });
    return;
  }

  res.status(200).json(serializePolicy(policy));
}

export async function upsert(req: Request, res: Response): Promise<void> {
  const userId = req.user?.id;
  if (!userId) {
    res.status(401).json({ error: "UNAUTHORIZED" });
    return;
  }

  const parsed = policyWriteSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "VALIDATION_ERROR", fields: fieldErrors(parsed.error) });
    return;
  }

  const { policy, created } = await upsertPolicyForUser(userId, parsed.data);
  res.status(created ? 201 : 200).json(serializePolicy(policy));
}

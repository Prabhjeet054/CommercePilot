import type { Request, Response } from "express";
import {
  DECISION_CONFLICT,
  decideApproval,
  getApprovalForUser,
  listPendingApprovals,
  serializeApproval,
} from "./approval.service";
import { approvalDecisionSchema, approvalIdParamSchema, fieldErrors } from "./approval.schema";

export async function listPending(req: Request, res: Response): Promise<void> {
  const userId = req.user?.id;
  if (!userId) {
    res.status(401).json({ error: "UNAUTHORIZED" });
    return;
  }

  const rows = await listPendingApprovals(userId);
  res.status(200).json({ approvals: rows.map(serializeApproval) });
}

export async function getOne(req: Request, res: Response): Promise<void> {
  const userId = req.user?.id;
  if (!userId) {
    res.status(401).json({ error: "UNAUTHORIZED" });
    return;
  }

  const id = approvalIdParamSchema.safeParse(req.params.id);
  if (!id.success) {
    res.status(404).json({ error: "NOT_FOUND" });
    return;
  }

  const approval = await getApprovalForUser(id.data, userId);
  if (!approval) {
    res.status(404).json({ error: "NOT_FOUND" });
    return;
  }

  res.status(200).json(serializeApproval(approval));
}

export async function decide(req: Request, res: Response): Promise<void> {
  const userId = req.user?.id;
  if (!userId) {
    res.status(401).json({ error: "UNAUTHORIZED" });
    return;
  }

  const id = approvalIdParamSchema.safeParse(req.params.id);
  if (!id.success) {
    res.status(404).json({ error: "NOT_FOUND" });
    return;
  }

  const parsed = approvalDecisionSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "VALIDATION_ERROR", fields: fieldErrors(parsed.error) });
    return;
  }

  const result = await decideApproval(id.data, userId, parsed.data.decision);
  if (!result.ok) {
    if (result.reason === DECISION_CONFLICT.NOT_FOUND) {
      res.status(404).json({ error: "NOT_FOUND" });
      return;
    }
    res.status(409).json({ error: result.reason });
    return;
  }

  const detailed = await getApprovalForUser(result.approval.id, userId);
  if (!detailed) {
    res.status(404).json({ error: "NOT_FOUND" });
    return;
  }

  res.status(200).json(serializeApproval(detailed));
}

import type { Request, Response } from "express";
import {
  IntentBudgetError,
  IntentExtractionError,
  IntentPromptError,
} from "../intent/intent.schema";
import {
  fieldErrors,
  createPurchaseIntentSchema,
  purchaseIntentIdParamSchema,
} from "./orchestrator.schema";
import {
  getStoredPurchaseIntent,
  runPurchaseIntentPipeline,
  serializeStoredPurchaseIntent,
} from "./purchase-intent";

function mapIntentError(err: unknown, res: Response): boolean {
  if (
    err instanceof IntentPromptError ||
    err instanceof IntentBudgetError ||
    err instanceof IntentExtractionError
  ) {
    res.status(400).json({ error: err.name, message: err.userMessage });
    return true;
  }
  return false;
}

export async function create(req: Request, res: Response): Promise<void> {
  const userId = req.user?.id;
  if (!userId) {
    res.status(401).json({ error: "UNAUTHORIZED" });
    return;
  }

  const parsed = createPurchaseIntentSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "VALIDATION_ERROR", fields: fieldErrors(parsed.error) });
    return;
  }

  try {
    const result = await runPurchaseIntentPipeline({
      userId,
      text: parsed.data.text,
      purchaseMode: parsed.data.purchaseMode,
    });
    res.status(201).json(result);
  } catch (err) {
    if (mapIntentError(err, res)) {
      return;
    }
    throw err;
  }
}

export async function getOne(req: Request, res: Response): Promise<void> {
  const userId = req.user?.id;
  if (!userId) {
    res.status(401).json({ error: "UNAUTHORIZED" });
    return;
  }

  const id = purchaseIntentIdParamSchema.safeParse(req.params.id);
  if (!id.success) {
    res.status(404).json({ error: "NOT_FOUND" });
    return;
  }

  const stored = await getStoredPurchaseIntent(id.data, userId);
  if (!stored) {
    res.status(404).json({ error: "NOT_FOUND" });
    return;
  }

  res.status(200).json(serializeStoredPurchaseIntent(stored));
}

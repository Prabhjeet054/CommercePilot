import type { Request, Response } from "express";
import {
  getAnalyticsForUser,
  MerchantNotAssociatedError,
} from "./analytics.service";

export async function getMerchantAnalytics(req: Request, res: Response): Promise<void> {
  const userId = req.user?.id;
  if (!userId) {
    res.status(401).json({ error: "UNAUTHORIZED" });
    return;
  }

  try {
    const analytics = await getAnalyticsForUser(userId);
    res.status(200).json(analytics);
  } catch (err) {
    if (err instanceof MerchantNotAssociatedError) {
      res.status(403).json({
        error: "MERCHANT_NOT_ASSOCIATED",
        message: "No merchant is associated with this admin account.",
      });
      return;
    }
    throw err;
  }
}

import type { NextFunction, Request, Response, Router } from "express";
import { Router as createRouter } from "express";
import { requireAuth } from "../../middleware/requireAuth";
import { requireRole } from "../../middleware/requireRole";
import * as analyticsController from "./analytics.controller";

function wrap(handler: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    void handler(req, res).catch(next);
  };
}

export function createAnalyticsRouter(): Router {
  const router = createRouter();

  router.get(
    "/analytics/merchant",
    requireAuth,
    requireRole(["merchant_admin"]),
    wrap(analyticsController.getMerchantAnalytics),
  );

  return router;
}

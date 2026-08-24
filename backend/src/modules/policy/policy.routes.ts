import type { NextFunction, Request, Response, Router } from "express";
import { Router as createRouter } from "express";
import { requireAuth } from "../../middleware/requireAuth";
import { requireRole } from "../../middleware/requireRole";
import * as policyController from "./policy.controller";

function wrap(handler: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    void handler(req, res).catch(next);
  };
}

export function createPolicyRouter(): Router {
  const router = createRouter();

  router.get(
    "/policies/me",
    requireAuth,
    requireRole(["customer"]),
    wrap(policyController.getMine),
  );
  router.post(
    "/policies",
    requireAuth,
    requireRole(["customer"]),
    wrap(policyController.upsert),
  );

  return router;
}

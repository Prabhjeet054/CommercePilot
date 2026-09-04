import type { NextFunction, Request, Response, Router } from "express";
import { Router as createRouter } from "express";
import { requireAuth } from "../../middleware/requireAuth";
import { requireRole } from "../../middleware/requireRole";
import * as paymentsController from "./payments.controller";

function wrap(handler: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    void handler(req, res).catch(next);
  };
}

export function createPaymentsRouter(): Router {
  const router = createRouter();

  router.post(
    "/payments/create-order",
    requireAuth,
    requireRole(["customer"]),
    wrap(paymentsController.createOrder),
  );

  return router;
}

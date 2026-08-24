import type { NextFunction, Request, Response, Router } from "express";
import { Router as createRouter } from "express";
import { requireAuth } from "../../middleware/requireAuth";
import { requireOwnership } from "../../middleware/requireOwnership";
import { requireRole } from "../../middleware/requireRole";
import * as catalogController from "./catalog.controller";
import { loadProductOwnership } from "./catalog.service";

function wrap(handler: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    void handler(req, res).catch(next);
  };
}

export function createCatalogRouter(): Router {
  const router = createRouter();

  router.get("/products", requireAuth, wrap(catalogController.list));
  router.get("/products/:id", requireAuth, wrap(catalogController.getOne));
  router.post(
    "/products",
    requireAuth,
    requireRole(["merchant_admin"]),
    wrap(catalogController.create),
  );
  router.put(
    "/products/:id",
    requireAuth,
    requireRole(["merchant_admin"]),
    requireOwnership(loadProductOwnership),
    wrap(catalogController.update),
  );
  router.get("/merchants/:id", requireAuth, wrap(catalogController.getMerchant));

  return router;
}

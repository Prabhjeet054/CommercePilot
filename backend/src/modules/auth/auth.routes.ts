import type { NextFunction, Request, Response, Router } from "express";
import { Router as createRouter } from "express";
import rateLimit from "express-rate-limit";
import { prisma } from "../../lib/prisma";
import { requireAuth } from "../../middleware/requireAuth";
import { requireOwnership } from "../../middleware/requireOwnership";
import { requireRole } from "../../middleware/requireRole";
import * as authController from "./auth.controller";

function wrap(handler: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    void handler(req, res).catch(next);
  };
}

const authLimiter = rateLimit({
  windowMs: 60_000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "TOO_MANY_REQUESTS" },
  keyGenerator: (req) => {
    const forwarded = req.headers["x-forwarded-for"];
    if (typeof forwarded === "string" && forwarded.length > 0) {
      return forwarded.split(",")[0]?.trim() ?? req.ip ?? "local";
    }
    return req.ip ?? "local";
  },
});

export function createAuthRouter(): Router {
  const router = createRouter();

  router.post("/register", authLimiter, wrap(authController.register));
  router.post("/login", authLimiter, wrap(authController.login));
  router.post("/refresh", wrap(authController.refresh));
  router.post("/logout", requireAuth, wrap(authController.logout));
  router.get("/me", requireAuth, wrap(authController.me));
  router.get(
    "/admin-check",
    requireAuth,
    requireRole(["merchant_admin"]),
    authController.adminCheck,
  );
  router.get(
    "/ownership-check/:userId",
    requireAuth,
    requireOwnership(async (req) => {
      const user = await prisma.user.findUnique({
        where: { id: req.params.userId },
        select: { id: true },
      });
      if (!user) {
        return null;
      }
      return { userId: user.id };
    }),
    authController.ownershipCheck,
  );

  return router;
}

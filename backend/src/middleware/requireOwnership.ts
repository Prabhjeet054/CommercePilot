import type { NextFunction, Request, Response } from "express";

/**
 * Load a resource and allow the request only if `resource.userId` matches the
 * authenticated user. Missing or foreign resources both return 404 (not 403)
 * so existence of another user's resource is not leaked.
 *
 * Later-phase example:
 *   router.get(
 *     "/purchase-intents/:id",
 *     requireAuth,
 *     requireOwnership((req) =>
 *       prisma.purchaseIntent.findUnique({ where: { id: req.params.id } }),
 *     ),
 *     controller.getOne,
 *   );
 */
export function requireOwnership<T extends { userId: string }>(
  loadResource: (req: Request) => Promise<T | null>,
) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!req.user) {
      res.status(401).json({ error: "UNAUTHORIZED" });
      return;
    }

    try {
      const resource = await loadResource(req);
      if (!resource || resource.userId !== req.user.id) {
        res.status(404).json({ error: "NOT_FOUND" });
        return;
      }
      next();
    } catch (error) {
      next(error);
    }
  };
}

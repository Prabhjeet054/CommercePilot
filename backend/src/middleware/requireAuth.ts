import type { NextFunction, Request, Response } from "express";
import { verifyAccessToken } from "../modules/auth/auth.service";

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    res.status(401).json({ error: "UNAUTHORIZED" });
    return;
  }

  const token = header.slice("Bearer ".length).trim();
  if (!token) {
    res.status(401).json({ error: "UNAUTHORIZED" });
    return;
  }

  const secret = req.app.locals.jwtSecret as string;
  try {
    const payload = verifyAccessToken(token, secret);
    req.user = { id: payload.sub, role: payload.role };
    next();
  } catch {
    res.status(401).json({ error: "UNAUTHORIZED" });
  }
}

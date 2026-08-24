import type { CookieOptions, Request, Response } from "express";
import {
  ACCESS_TOKEN_TTL,
  INVALID_CREDENTIALS,
  REFRESH_COOKIE_NAME,
  authenticateUser,
  findPublicUserById,
  registerUser,
  revokeRefreshToken,
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
} from "./auth.service";
import { fieldErrors, loginSchema, registerSchema } from "./auth.schema";

type AuthLocals = {
  jwtSecret: string;
  jwtRefreshSecret: string;
  cookieSecure: boolean;
};

function authLocals(req: Request): AuthLocals {
  return {
    jwtSecret: req.app.locals.jwtSecret as string,
    jwtRefreshSecret: req.app.locals.jwtRefreshSecret as string,
    cookieSecure: Boolean(req.app.locals.cookieSecure),
  };
}

export function refreshCookieOptions(secure: boolean): CookieOptions {
  return {
    httpOnly: true,
    sameSite: "strict",
    secure,
    path: "/auth",
    maxAge: 7 * 24 * 60 * 60 * 1000,
  };
}

function issueTokens(res: Response, user: { id: string; role: string }, locals: AuthLocals): string {
  const accessToken = signAccessToken(user, locals.jwtSecret, ACCESS_TOKEN_TTL);
  const refreshToken = signRefreshToken(user, locals.jwtRefreshSecret);
  res.cookie(REFRESH_COOKIE_NAME, refreshToken, refreshCookieOptions(locals.cookieSecure));
  return accessToken;
}

export async function register(req: Request, res: Response): Promise<void> {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "VALIDATION_ERROR", fields: fieldErrors(parsed.error) });
    return;
  }

  const result = await registerUser(parsed.data);
  if ("duplicate" in result) {
    res.status(409).json({ error: "EMAIL_ALREADY_EXISTS" });
    return;
  }

  const accessToken = issueTokens(res, result.user, authLocals(req));
  res.status(201).json({ accessToken, user: result.user });
}

export async function login(req: Request, res: Response): Promise<void> {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "VALIDATION_ERROR", fields: fieldErrors(parsed.error) });
    return;
  }

  const user = await authenticateUser(parsed.data);
  if (!user) {
    res.status(401).json({ error: INVALID_CREDENTIALS });
    return;
  }

  const accessToken = issueTokens(res, user, authLocals(req));
  res.status(200).json({ accessToken, user });
}

export async function refresh(req: Request, res: Response): Promise<void> {
  const token = req.cookies?.[REFRESH_COOKIE_NAME];
  if (typeof token !== "string" || token.length === 0) {
    res.status(401).json({ error: "UNAUTHORIZED" });
    return;
  }

  const locals = authLocals(req);
  try {
    const payload = verifyRefreshToken(token, locals.jwtRefreshSecret);
    const user = await findPublicUserById(payload.sub);
    if (!user) {
      res.status(401).json({ error: "UNAUTHORIZED" });
      return;
    }
    const accessToken = signAccessToken(user, locals.jwtSecret, ACCESS_TOKEN_TTL);
    res.status(200).json({ accessToken });
  } catch {
    res.status(401).json({ error: "UNAUTHORIZED" });
  }
}

export async function logout(req: Request, res: Response): Promise<void> {
  const locals = authLocals(req);
  const token = req.cookies?.[REFRESH_COOKIE_NAME];
  if (typeof token === "string" && token.length > 0) {
    revokeRefreshToken(token, locals.jwtRefreshSecret);
  }
  res.clearCookie(REFRESH_COOKIE_NAME, {
    httpOnly: true,
    sameSite: "strict",
    secure: locals.cookieSecure,
    path: "/auth",
  });
  res.status(200).json({ success: true });
}

export async function me(req: Request, res: Response): Promise<void> {
  const userId = req.user?.id;
  if (!userId) {
    res.status(401).json({ error: "UNAUTHORIZED" });
    return;
  }

  const user = await findPublicUserById(userId);
  if (!user) {
    res.status(401).json({ error: "UNAUTHORIZED" });
    return;
  }

  res.status(200).json({ user });
}

export function adminCheck(_req: Request, res: Response): void {
  res.status(200).json({ ok: true });
}

export function ownershipCheck(_req: Request, res: Response): void {
  res.status(200).json({ ok: true });
}

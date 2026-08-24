import { randomUUID } from "crypto";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import type { LoginInput, RegisterInput } from "./auth.schema";

export const BCRYPT_COST = 12;
export const ACCESS_TOKEN_TTL = "15m";
export const REFRESH_TOKEN_TTL = "7d";
export const REFRESH_COOKIE_NAME = "refreshToken";
export const INVALID_CREDENTIALS = "Invalid credentials";

export type PublicUser = {
  id: string;
  email: string;
  role: string;
  name: string | null;
  merchantId: string | null;
};

export type AccessTokenPayload = {
  sub: string;
  role: string;
  typ: "access";
};

export type RefreshTokenPayload = {
  sub: string;
  role: string;
  typ: "refresh";
  jti: string;
};

const revokedRefreshJtis = new Set<string>();

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_COST);
}

export async function verifyPassword(password: string, passwordHash: string): Promise<boolean> {
  return bcrypt.compare(password, passwordHash);
}

export function signAccessToken(
  user: { id: string; role: string },
  secret: string,
  expiresIn: jwt.SignOptions["expiresIn"] = ACCESS_TOKEN_TTL,
): string {
  const payload: AccessTokenPayload = { sub: user.id, role: user.role, typ: "access" };
  return jwt.sign(payload, secret, { expiresIn });
}

export function signRefreshToken(
  user: { id: string; role: string },
  secret: string,
  expiresIn: jwt.SignOptions["expiresIn"] = REFRESH_TOKEN_TTL,
): string {
  const payload: RefreshTokenPayload = {
    sub: user.id,
    role: user.role,
    typ: "refresh",
    jti: randomUUID(),
  };
  return jwt.sign(payload, secret, { expiresIn });
}

export function verifyAccessToken(token: string, secret: string): AccessTokenPayload {
  const decoded = jwt.verify(token, secret);
  if (typeof decoded !== "object" || decoded === null) {
    throw new jwt.JsonWebTokenError("invalid token");
  }
  const payload = decoded as Partial<AccessTokenPayload>;
  if (payload.typ !== "access" || typeof payload.sub !== "string" || typeof payload.role !== "string") {
    throw new jwt.JsonWebTokenError("invalid access token");
  }
  return { sub: payload.sub, role: payload.role, typ: "access" };
}

export function verifyRefreshToken(token: string, secret: string): RefreshTokenPayload {
  const decoded = jwt.verify(token, secret);
  if (typeof decoded !== "object" || decoded === null) {
    throw new jwt.JsonWebTokenError("invalid token");
  }
  const payload = decoded as Partial<RefreshTokenPayload>;
  if (
    payload.typ !== "refresh" ||
    typeof payload.sub !== "string" ||
    typeof payload.role !== "string" ||
    typeof payload.jti !== "string"
  ) {
    throw new jwt.JsonWebTokenError("invalid refresh token");
  }
  if (revokedRefreshJtis.has(payload.jti)) {
    throw new jwt.JsonWebTokenError("refresh token revoked");
  }
  return {
    sub: payload.sub,
    role: payload.role,
    typ: "refresh",
    jti: payload.jti,
  };
}

export function revokeRefreshToken(token: string, secret: string): void {
  try {
    const payload = verifyRefreshToken(token, secret);
    revokedRefreshJtis.add(payload.jti);
  } catch {
    try {
      const decoded = jwt.decode(token);
      if (decoded && typeof decoded === "object" && typeof decoded.jti === "string") {
        revokedRefreshJtis.add(decoded.jti);
      }
    } catch {
      // Cookie clearing still happens at the HTTP layer.
    }
  }
}

export function toPublicUser(user: {
  id: string;
  email: string;
  role: string;
  name: string | null;
  merchantId: string | null;
}): PublicUser {
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    name: user.name,
    merchantId: user.merchantId,
  };
}

export async function registerUser(
  input: RegisterInput,
): Promise<{ user: PublicUser } | { duplicate: true }> {
  const email = normalizeEmail(input.email);
  const passwordHash = await hashPassword(input.password);

  try {
    const user = await prisma.user.create({
      data: {
        email,
        passwordHash,
        role: input.role,
        name: input.name,
      },
    });
    return { user: toPublicUser(user) };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return { duplicate: true };
    }
    throw error;
  }
}

export async function authenticateUser(
  input: LoginInput,
): Promise<PublicUser | null> {
  const email = normalizeEmail(input.email);
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    await hashPassword(input.password);
    return null;
  }

  const matches = await verifyPassword(input.password, user.passwordHash);
  if (!matches) {
    return null;
  }

  return toPublicUser(user);
}

export async function findPublicUserById(id: string): Promise<PublicUser | null> {
  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) {
    return null;
  }
  return toPublicUser(user);
}

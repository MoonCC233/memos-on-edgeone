import { SignJWT, jwtVerify } from "jose";
import type { JWTClaims, UserPayload } from "../types";

const ISSUER = "memos";
const ACCESS_AUD = "user.access-token";
const REFRESH_AUD = "user.refresh-token";
const ACCESS_TTL = 15 * 60;
const REFRESH_TTL = 30 * 24 * 60 * 60;

function getSecretKey(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

export async function createAccessToken(
  user: UserPayload,
  secret: string
): Promise<{ token: string; expiresAt: number }> {
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + ACCESS_TTL;
  const key = getSecretKey(secret);

  const token = await new SignJWT({
    name: user.username,
    role: user.role,
    status: user.status,
  })
    .setProtectedHeader({ alg: "HS256", kid: "v1" })
    .setSubject(String(user.id))
    .setIssuer(ISSUER)
    .setAudience(ACCESS_AUD)
    .setIssuedAt(now)
    .setExpirationTime(expiresAt)
    .sign(key);

  return { token, expiresAt };
}

export async function createRefreshToken(
  user: UserPayload,
  tokenId: string,
  secret: string
): Promise<{ token: string; expiresAt: number }> {
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + REFRESH_TTL;
  const key = getSecretKey(secret);

  const token = await new SignJWT({
    tid: tokenId,
    name: user.username,
    role: user.role,
    status: user.status,
  })
    .setProtectedHeader({ alg: "HS256", kid: "v1" })
    .setSubject(String(user.id))
    .setIssuer(ISSUER)
    .setAudience(REFRESH_AUD)
    .setIssuedAt(now)
    .setExpirationTime(expiresAt)
    .sign(key);

  return { token, expiresAt };
}

export async function verifyAccessToken(
  token: string,
  secret: string
): Promise<JWTClaims> {
  const key = getSecretKey(secret);
  const { payload } = await jwtVerify(token, key, {
    issuer: ISSUER,
    audience: ACCESS_AUD,
  });
  return payload as unknown as JWTClaims;
}

export async function verifyRefreshToken(
  token: string,
  secret: string
): Promise<JWTClaims> {
  const key = getSecretKey(secret);
  const { payload } = await jwtVerify(token, key, {
    issuer: ISSUER,
    audience: REFRESH_AUD,
  });
  return payload as unknown as JWTClaims;
}

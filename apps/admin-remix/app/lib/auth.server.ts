import { redirect } from "@remix-run/node";
import argon2 from "argon2";
import crypto from "crypto";
import { authenticator } from "otplib";
import { validate as validateUuid } from "uuid";
import { AuthRepository, CustomersRepository } from "@starkeep/admin-db";
import { commitSession, destroySession, getSession } from "./session.server";
import { isEmailEnabled, sendInviteEmail, sendMagicLinkEmail } from "./email.server";

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30;
const MAGIC_LINK_TTL_MS = 1000 * 60 * 15;
const INVITE_TTL_MS = 1000 * 60 * 60 * 24 * 7;
const RECOVERY_CODE_COUNT = 10;

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

function getEncryptionKey(): Buffer {
  const configured = process.env.AUTH_ENCRYPTION_KEY;
  if (!configured && process.env.NODE_ENV === "production") {
    throw new Error("AUTH_ENCRYPTION_KEY is not configured");
  }

  const key = configured
    ? Buffer.from(configured, "base64")
    : crypto.createHash("sha256").update("dev-auth-key").digest();

  if (key.length !== 32) {
    throw new Error("AUTH_ENCRYPTION_KEY must be 32 bytes base64 encoded");
  }

  return key;
}

function encryptSecret(plainText: string): string {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString("base64");
}

function decryptSecret(payload: string): string {
  const key = getEncryptionKey();
  const buffer = Buffer.from(payload, "base64");
  const iv = buffer.subarray(0, 12);
  const tag = buffer.subarray(12, 28);
  const data = buffer.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function generateToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

function generateRecoveryCodes(): string[] {
  return Array.from({ length: RECOVERY_CODE_COUNT }, () => {
    const raw = crypto.randomBytes(4).toString("hex");
    return `${raw.slice(0, 4)}-${raw.slice(4)}`;
  });
}

function normalizeRecoveryCode(code: string): string {
  return code.replace(/\s+/g, "").toLowerCase();
}

export async function registerUser(input: {
  email: string;
  password: string;
  customerName: string;
}) {
  const authRepo = new AuthRepository();
  const customersRepo = new CustomersRepository();
  const email = normalizeEmail(input.email);
  const existing = await authRepo.findUserByEmail(email);
  if (existing) {
    throw new Error("User already exists");
  }

  const customer = await customersRepo.create({
    email,
    name: input.customerName,
  });

  const user = await authRepo.createUser(email);
  await authRepo.createMembership(user.id, customer.id, "owner");

  const passwordHash = await argon2.hash(input.password, { type: argon2.argon2id });
  await authRepo.upsertPassword(user.id, passwordHash);
  if (!isEmailEnabled()) {
    await authRepo.markEmailVerified(user.id);
  }

  return { user, customer };
}

export async function verifyPassword(email: string, password: string) {
  const authRepo = new AuthRepository();
  const normalized = normalizeEmail(email);
  const user = await authRepo.findUserByEmail(normalized);
  if (!user) {
    return null;
  }

  const stored = await authRepo.getPassword(user.id);
  if (!stored) {
    return null;
  }

  const match = await argon2.verify(stored.password_hash, password);
  if (!match) {
    return null;
  }

  return user;
}

export async function requireUserId(request: Request) {
  // Hardcoded for development - bypass authentication
  return "00000000-0000-0000-0000-000000000001";
}

export async function requireCustomerId(request: Request) {
  // Hardcoded for development - bypass authentication
  return "00000000-0000-0000-0000-000000000001";
}

export async function createSessionForUser(request: Request, userId: string) {
  const authRepo = new AuthRepository();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  const sessionRecord = await authRepo.createSession(userId, expiresAt);
  const session = await getSession(request);
  session.set("sessionId", sessionRecord.id);
  session.unset("pending2faUserId");
  session.unset("totpSetupSecret");
  session.unset("inviteUserId");
  return commitSession(session);
}

export async function startTwoFactorChallenge(request: Request, userId: string) {
  const session = await getSession(request);
  session.set("pending2faUserId", userId);
  session.unset("sessionId");
  return commitSession(session);
}

export async function finishTwoFactorChallenge(request: Request) {
  const session = await getSession(request);
  session.unset("pending2faUserId");
  return commitSession(session);
}

export async function getPendingTwoFactorUserId(request: Request) {
  const session = await getSession(request);
  const pending = session.get("pending2faUserId");
  return typeof pending === "string" && validateUuid(pending) ? pending : null;
}

export async function logout(request: Request) {
  const session = await getSession(request);
  const sessionId = session.get("sessionId");
  if (typeof sessionId === "string") {
    const authRepo = new AuthRepository();
    await authRepo.revokeSession(sessionId);
  }
  return destroySession(session);
}

export async function sendMagicLink(request: Request, email: string) {
  const authRepo = new AuthRepository();
  const normalized = normalizeEmail(email);
  const user = await authRepo.findUserByEmail(normalized);
  if (!isEmailEnabled()) {
    return { disabled: true, sent: false };
  }
  if (!user) {
    return { disabled: false, sent: false };
  }

  const token = generateToken();
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + MAGIC_LINK_TTL_MS);
  await authRepo.createMagicLink(user.id, tokenHash, expiresAt);

  const baseUrl = process.env.APP_BASE_URL || new URL(request.url).origin;
  const link = `${baseUrl}/auth/magic-link/verify?token=${token}`;
  const sent = await sendMagicLinkEmail(user.email, link);
  return { disabled: false, sent };
}

export async function consumeMagicLink(token: string) {
  const authRepo = new AuthRepository();
  const tokenHash = hashToken(token);
  return authRepo.consumeMagicLink(tokenHash);
}

export async function createInvitation(request: Request, input: {
  email: string;
  customerId: string;
  createdByUserId: string;
}) {
  const authRepo = new AuthRepository();
  const email = normalizeEmail(input.email);
  if (!isEmailEnabled()) {
    return { disabled: true, sent: false };
  }

  const token = generateToken();
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
  await authRepo.createInvitation(input.customerId, email, tokenHash, expiresAt, input.createdByUserId);

  const baseUrl = process.env.APP_BASE_URL || new URL(request.url).origin;
  const link = `${baseUrl}/auth/invite/accept?token=${token}`;
  const sent = await sendInviteEmail(email, link);
  return { disabled: false, sent };
}

export async function consumeInvitation(token: string) {
  const authRepo = new AuthRepository();
  const tokenHash = hashToken(token);
  return authRepo.consumeInvitation(tokenHash);
}

export async function ensureMembership(userId: string, customerId: string) {
  const authRepo = new AuthRepository();
  return authRepo.createMembership(userId, customerId, "member");
}

export async function markEmailVerified(userId: string) {
  const authRepo = new AuthRepository();
  await authRepo.markEmailVerified(userId);
}

export async function getTotp(userId: string) {
  const authRepo = new AuthRepository();
  return authRepo.getTotp(userId);
}

export function generateTotpSecret(email: string) {
  const secret = authenticator.generateSecret();
  const otpauth = authenticator.keyuri(email, "Starkeeper", secret);
  return { secret, otpauth };
}

export function verifyTotp(code: string, secret: string) {
  return authenticator.check(code, secret);
}

export async function enableTotp(userId: string, secret: string) {
  const authRepo = new AuthRepository();
  const encrypted = encryptSecret(secret);
  await authRepo.upsertTotp(userId, encrypted);
}

export function decryptTotpSecret(secretEncrypted: string) {
  return decryptSecret(secretEncrypted);
}

export async function createRecoveryCodes(userId: string) {
  const codes = generateRecoveryCodes();
  const hashes = codes.map((code) => hashToken(normalizeRecoveryCode(code)));
  const authRepo = new AuthRepository();
  await authRepo.replaceRecoveryCodes(userId, hashes);
  return codes;
}

export async function consumeRecoveryCode(userId: string, code: string) {
  const authRepo = new AuthRepository();
  const normalized = normalizeRecoveryCode(code);
  const hash = hashToken(normalized);
  return authRepo.consumeRecoveryCode(userId, hash);
}

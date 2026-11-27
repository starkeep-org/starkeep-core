/**
 * A stand-in for the shared admin session (`@starkeep/operator/admin-session`)
 * in route and page tests. The real module refreshes tokens at Cognito and
 * exchanges them at the identity pool; these tests care only whether a session
 * exists and which credentials it mints.
 *
 * Use it from a test file with:
 *
 *   vi.mock("@starkeep/operator/admin-session", async (original) =>
 *     (await import("./fake-admin-session")).fakeAdminSessionModule(await original()),
 *   );
 *
 * and `signInFake()` / `signOutFake()` to set the state.
 */
import { vi } from "vitest";

export const FAKE_ADMIN_CREDENTIALS = {
  accessKeyId: "AKIAFAKEADMIN",
  secretAccessKey: "fake-secret",
  sessionToken: "fake-session-token",
  expiration: "2030-01-01T00:00:00.000Z",
};

export const FAKE_ADMIN = {
  credentials: {
    ...FAKE_ADMIN_CREDENTIALS,
    expiration: new Date(FAKE_ADMIN_CREDENTIALS.expiration),
  },
  stsCredentials: FAKE_ADMIN_CREDENTIALS,
  idToken: "fake.id.token",
  email: "admin@example.com",
  sub: "sub-admin",
  region: "us-east-2",
  stackPrefix: "sktest",
};

let signedIn = true;

export function signInFake(): void {
  signedIn = true;
}

export function signOutFake(): void {
  signedIn = false;
}

export function fakeAdminSessionModule(original: Record<string, unknown>) {
  const SignInRequired = original.SignInRequired as new (message?: string) => Error;
  return {
    ...original,
    adminCredentials: vi.fn(async () => {
      if (!signedIn) throw new SignInRequired();
      return FAKE_ADMIN;
    }),
    adminSessionStatus: vi.fn(() =>
      signedIn
        ? {
            signedIn: true,
            email: FAKE_ADMIN.email,
            sub: FAKE_ADMIN.sub,
            expiresAt: "2030-01-01T00:00:00.000Z",
          }
        : { signedIn: false, email: null, sub: null, expiresAt: null },
    ),
    saveAdminSignIn: vi.fn(async () => {
      signedIn = true;
    }),
    signOutAdmin: vi.fn(async () => {
      signedIn = false;
      return { revoked: true };
    }),
  };
}

# @starkeep/app-client

## 0.10.0

### Minor Changes

- 18b7a5f: Cloud app sign-in moves to Cognito's managed login page, so app code never sees a password. The platform's `/auth/start`, `/auth/callback` and `/auth/sign-out` routes set each app's `sk_session` and `sk_token` cookies at that app's path. The `@starkeep/app-client/session-cookies` subpath exports `signInAddress`, `signOutAddress` and the cookie names, with no dependencies.

  Breaking: `initiateAuth`, `respondNewPassword` and `InitiateResult` are gone from `@starkeep/app-client/auth`, and the session routes no longer accept a password. A cloud app's server mints its user token from the session cookie with `mintIdToken`, which now uses the cloud-apps client.

## 0.9.1

### Patch Changes

- Comment-only changes since 0.9.0.

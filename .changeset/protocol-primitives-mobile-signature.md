---
"@starkeep/protocol-primitives": minor
---

Mobile apps sign their requests with an attested key. `device-session/mobile-signature` defines the `X-Starkeep-Key-Id` and `X-Starkeep-Key-Sig` headers and the message a phone signs with its Keystore key, and `GET /auth/config` reports `cognitoDomain` and `mobileClientId` beside the device client. The session store, `PendingRevocation`, `CognitoClientFor` and the session helpers are generic over the auth config, defaulting to `DeviceAuthConfig`, so a phone can keep its own config shape.

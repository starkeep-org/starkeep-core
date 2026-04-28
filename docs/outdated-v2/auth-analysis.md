# Starkeep Authentication Analysis

## Current State

Starkeep already has a **policy-based access control engine** (`packages/access-control/`) that handles *authorization* — who can read/write/delete what. It supports:
- Subject types: `user | app | api | token`
- Hierarchical policies (per-item, per-type, wildcard)
- Sharing tokens with expiry and usage limits
- An `EnforcedDatabaseAdapter` that wraps storage to enforce policies

What's **missing** is *authentication* — proving you are who you claim to be. The data-server currently runs on localhost with a hardcoded `OWNER_ID`, no login, and `Access-Control-Allow-Origin: *`. The shared-space-api accepts a subject in headers but never verifies it.

---

## Where Auth Would Be Needed

### 1. Remote access to your own Starkeep instance

Right now the data-server binds to `127.0.0.1` — it's inaccessible remotely. If you expose it (via tunnel, VPN, or public hosting), you need to authenticate that it's actually you. Options:
- **Passkey / WebAuthn** — passwordless, phishing-resistant, works great for single-user. You register your devices, they prove identity via biometrics/hardware key.
- **mTLS / client certificates** — each authorized device gets a client cert. No passwords, very secure, but clunky UX.
- **Simple API key / bearer token** — you generate a secret, store it in your client. Dead simple, good enough for personal use behind HTTPS.
- **Tailscale / WireGuard** — network-level auth. Your Starkeep instance is only reachable from your own mesh network. No app-level auth needed at all.

### 2. Sharing with other people

The access-control package already supports sharing tokens (`generateToken()` with expiry and max-use limits). The gap is in how recipients *present* those tokens. You'd need:
- **Token-in-URL (link sharing)** — `https://your-instance/shared/abc123` — the token IS the auth. Simple, like a Google Photos share link. Already half-built with the sharing token system.
- **Invited users with their own identity** — if you want to give someone ongoing access (not just a one-time link), they need an identity your system recognizes. This could be:
  - Email + magic link (passwordless, no registration friction)
  - OAuth (sign in with Google/GitHub) — offloads identity verification to a provider
  - Their own Starkeep identity (federated, longer-term vision)

### 3. App-to-API authentication

When third-party apps use your Shared Space APIs, they need to prove they're authorized. The API framework has a subject model but doesn't verify it. Options:
- **OAuth 2.0 scopes** — apps request specific permissions, you approve. Standard, well-understood.
- **API keys per app** — simpler. You register an app, get a key, key maps to an access policy.
- **Signed requests (HMAC)** — like the file-token system in data-server, but generalized.

### 4. Sync engine authentication

The sync engine currently trusts both endpoints. When syncing local ↔ cloud, both sides need to verify identity:
- Cloud side: AWS IAM + the provisioned per-user resources handle this naturally
- Local side connecting to cloud: needs a credential (AWS creds, or a Starkeep-issued token that maps to AWS access)

### 5. Cross-instance federation (future)

If two Starkeep users want to share data between their own instances, you'd need mutual authentication — each instance proving its identity to the other. This is further out but worth noting.

---

## Recommendation: Layered Approach

| Layer | Mechanism | Effort |
|-------|-----------|--------|
| **Owner remote access** | API key/bearer token over HTTPS (simplest) or Tailscale (zero app changes) | Low |
| **Link sharing** | Extend existing sharing tokens to work as bearer auth in the API layer | Low — builds on what exists |
| **Invited users** | Magic link / email-based (no passwords to manage) | Medium |
| **App auth** | API keys mapped to access policies | Medium |
| **Full multi-user** | OAuth 2.0 / OpenID Connect | High |

The key architectural decision is: **do you want Starkeep itself to be an identity provider, or always delegate identity to something external?** Given the "user-owned data" philosophy, leaning toward delegating — use something like Passkeys for owner auth and OAuth/magic links for guests — so you're not in the business of storing credentials.

# @starkeep/protocol-primitives

## 0.12.0

### Minor Changes

- 4838b92: MCP clients such as claude.ai, ChatGPT and Claude Code can now connect to an app's delegated route with OAuth instead of a pasted token. The platform serves the discovery documents, the sign-in and the tokens, so an app needs no new code. Pass the request to `delegationRefusal(req)` in `@starkeep/app-client`, so its 401 says `error="invalid_token"` when the request carried a bearer token, which tells the client to refresh. `delegationRefusal()` with no request still answers a bare challenge.

  `@starkeep/protocol-primitives` adds the OAuth route paths, the `skr_` refresh token prefix, the scope names and the access token lifetime.

## 0.11.0

### Minor Changes

- 380bb3f: Outside clients, such as MCP clients and scripts, can reach one app's data with a delegation token the user creates on the platform's consent page. A manifest route declares `"auth": "delegated"` for such a client, and `verifyDelegation(req)` in `@starkeep/app-client` tells the route whose request it is. Pass the returned token to `signedFetch` (`delegation`) or `proxyToDataServer` (`delegationToken`) so the platform applies the token's mode and revocation to each data call. On the local surface a loopback caller passes with no token.

  The manifest validator refuses `auth: "public"` on a handler or a route, and accepts a `publicPaths` entry only when it is a platform page or one of the handler's `staticAssetPaths`. A manifest that used either must move the route to `"delegated"` or drop it.

- 1460d5c: A record keeps its source file's own dates. `DataRecord` gains `originalCreatedAt` and `originalUpdatedAt`, ISO 8601 strings or null, and `createDataRecord` takes both as optional input. Both stores add the `original_created_at` and `original_updated_at` columns, and an existing SQLite database or DSQL cluster gains them when the data server starts. The records grammar can filter and order on both columns. Only the local folder watcher fills them, from the file's birth time and modification time.

## 0.10.0

### Minor Changes

- a3a8ca5: Add `PROTOCOL_VERSION`, the version of the contract between the platform and an app, with `parseProtocolVersion` and `protocolSatisfies`. A minor bump marks an addition an app can depend on; a major bump marks a breaking change. `protocolMinVersion` in a manifest must now be a `major.minor.patch` version.

## 0.9.0

### Minor Changes

- 8dbd1c4: Register the `example` category and its one type, `example/plaintext` (extension `.skexample`), with a metadata table of `line_count`, `word_count` and `char_count`. The Starkeep example app writes only this type, so trying the example on a real deployment never mixes invented files into a person's library.

## 0.8.0

### Minor Changes

- 39e3d86: `escapeMarkup` escapes `&`, `<`, `>`, `"` and `'` for HTML or XML, as element content or a quoted attribute value. The cloud data server's sign-in pages and the managed login SVG both use it, in place of two private copies.

## 0.7.0

### Minor Changes

- 18b7a5f: Mobile apps sign their requests with an attested key. `device-session/mobile-signature` defines the `X-Starkeep-Key-Id` and `X-Starkeep-Key-Sig` headers and the message a phone signs with its Keystore key, and `withMobileKeySignature` wraps a `fetch` to sign every request to a channel, and `GET /auth/config` reports `cognitoDomain` and `mobileClientId` beside the device client. The session store, `PendingRevocation`, `CognitoClientFor` and the session helpers are generic over the auth config, defaulting to `DeviceAuthConfig`, so a phone can keep its own config shape.

## 0.6.0

### Minor Changes

- fcd80e9: The cloud signs no URL for a shared file that has not reached S3. `RecordAvailability` gains `awaiting-upload`, stand-in sizes and variant candidates carry `awaiting_upload: true` in place of a URL, and the single-record reads answer `409 AwaitingUpload`. `VariantCandidate` carries the child's `updatedAt`, which the cloud compares with Drive's bytes watermark. `verify()` reports `filesOwed` and `filesOwedCapped`: the files the peer is still owed, since rows now reach it ahead of their files.

## 0.5.0

### Minor Changes

- Publish the engine changes made since the 0.4 package set (2026-08-02) and the 0.3 set (2026-07-29), which went unpublished: sync in bounded rounds with a delta scan, and the residency fixes; content-addressed shared records keyed on parent, filename and hash; metadata that syncs with its record; the shared query grammar; stand-ins and the reduced storage settings; record deletion, the deleted feed and blob reclamation; rows that travel ahead of their files; and per-user object keys, user-scoped cloud statements and device sign-in. Most of these change the wire format or the stored layout, so every node must run this set together.

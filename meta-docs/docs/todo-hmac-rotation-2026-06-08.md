# TODO: In-place HMAC rotation for installed local apps

The only way to rotate a leaked HMAC secret today is uninstall + reinstall,
which drops the app's `appSpecificSyncable` tables and forces a re-sync from
the cloud peer (or accepts data loss if there is no peer). During local
development a misplaced `console.log` of the secret has a punishingly
expensive recovery story.

A `rotate-hmac` operation that updates the `shared_app_registry` row's
`hmac_secret` and rewrites `$STARKEEP_DATA_DIR/app-creds/<appId>.json`
without touching any app-specific tables would be small. It does not need
the install ledger — the two writes are independent and the rotation has
no partial-success state worth recovering from (operator can re-rotate).

Wire-up:

- Admin-web: a Rotate button on the app card, calling
  `POST /api/apps/rotate-hmac { appId }`.
- That route forwards to a new local-data-server admin endpoint
  `POST /admin/apps/:appId/rotate-hmac` that updates `shared_app_registry`,
  then rewrites the creds file via the same path admin-web uses for install.
- App process must be restarted to pick up the new secret (the app-client
  in-process cache assumes rotation only happens while the app is down).
  The Rotate button should either stop+rotate+start the app daemon, or warn
  the operator to restart it.

Surfaced during processing of doc id 21 (Developing a local app for Starkeep
— Functional Review, 2026-06-08), Part 2 — Missing behaviors. Also noted in
the older `local-apps` review.

Revisit when: a secret leak is reported / suspected, or someone is touching
install/uninstall and the marginal cost of adding rotate is small.

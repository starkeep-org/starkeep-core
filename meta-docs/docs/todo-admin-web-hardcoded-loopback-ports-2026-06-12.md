# TODO: admin-web browser-side code hardcodes 127.0.0.1:9820 / drive :9830

admin-web's **API routes** honor `STARKEEP_LOCAL_DATA_SERVER_URL` (install,
uninstall, list, install-status), which is what lets the e2e harness run the
whole stack on ephemeral ports. But the **browser-side** code still
hardcodes the loopback defaults:

- `app/(shell)/page.tsx` — dashboard health probe, `/watches`, `/config`,
  `/auth/tokens`, `/auth/logout` all fetch `http://127.0.0.1:9820` directly
  from the browser.
- `src/components/CloudSetupWizard.tsx` — `LOCAL_DATA_SERVER_URL` constant.
- `src/lib/data-client.ts` — `LOCAL_URL` constant.
- The Drive card (`apps/page.tsx` `DRIVE_URL`) and daemon command map assume
  drive on `localhost:9830`.

Consequences: (a) in a harness-booted stack the dashboard page shows a dead
local server even though everything is running (the e2e suite works around
this by only driving flows that go through API routes); (b) the
browser→LDS direct calls are a second, unsigned access path that bypasses
the server-side route layer — the loopback-auth surface of the LDS is doing
the gating.

A small fix would thread the configured URL through a server component or a
`/api/config`-style bootstrap instead of constants. Not urgent — on a real
single-machine install the constants are always right — but it blocks any
future e2e coverage of the dashboard, wizard, and watch-management UI.

Also note (environmental, no code change needed): browser-facing dev URLs
must use `localhost`, not `127.0.0.1` — Next 16's dev-origin protection
drops the turbopack HMR websocket for the bare IP and hydration stalls.
Documented in `e2e/README.md`.

Surfaced while building the Tier-2 e2e harness (2026-06-12).

Revisit when: e2e coverage of the dashboard/wizard/watches UI is wanted, or
when anyone touches the admin-web ↔ LDS plumbing.

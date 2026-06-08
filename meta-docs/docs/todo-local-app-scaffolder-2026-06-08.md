# TODO: Local-app scaffolder / template

A developer starting a new local Starkeep app today has to read the Photos
manifest, learn the manifest schema by trial and error against the validator,
and reproduce the credentials/proxy setup from scratch (even though
`@starkeep/app-client` now owns the runtime pieces). Two viable shapes:

- **Light: `starkeep-apps/_template/` directory.** A copy-paste-ready Next.js
  app skeleton with a stub `starkeep.manifest.json` (sample `fileAccess` +
  `appSpecificSyncable` entries), `app/api/local-data/[...path]/route.ts`
  wired up via `createNextProxyHandler`, and a README walking through the
  fill-in points. 6–8 files; light surface to maintain.
- **Heavy: `pnpm create starkeep-app` generator.** Interactive prompts driven
  by the manifest's Zod schema (`packages/admin-manifest/src/schema.ts`),
  producing a known-good starting point per app type. Real package, tests,
  publish story. Use this if/when there are 3+ local apps in the wild.

Start with the light template; promote to the generator only if the template
proves to be a recurring divergence point.

Surfaced during processing of doc id 21 (Developing a local app for Starkeep
— Functional Review, 2026-06-08), Part 2 — Missing behaviors.

Revisit when: a third local app is being started (Photos + one more is not
yet enough to justify the template-vs-app-copy trade-off), or someone wants
to remove the "read the Photos manifest first" step from onboarding.

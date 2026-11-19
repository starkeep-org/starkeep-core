---
"@starkeep/app-client": minor
---

The credential vault. `listSecrets`, `putSecret` and `deleteSecret` store a user's secrets for the app's third-party services, with the user's token, through the app's server. A run of one of the app's scheduled jobs reads its user's secret with `readSecret` and writes a rotated value with `putSecret`, with the run's token. The browser never reads a secret back. On the local surface every call answers `cloudRequired: true`.

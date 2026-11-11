---
"@starkeep/admin-manifest": patch
---

The `localRun.portFlag` documentation says that admin-web keeps an app on one port, so the app keeps one browser origin across restarts. The port changes only when the app is reinstalled or the operator moves it off a port that another program holds.

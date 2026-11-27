---
"@starkeep/admin-manifest": minor
---

Public sites. `infraRequirements.publicSite: { bundleDir }` names a folder in the app's bundle that anyone on the internet can read without signing in, at `/sites/<appId>/` on the deployment. CloudFront serves the folder from S3, so no Lambda runs for a visitor, and an app may declare a site with no compute. The validator refuses a site on an app whose targets omit `"cloud"`. `publicSitePath` and `PUBLIC_SITE_ASSET_PREFIX` name the site's address and its folder in the app assets bucket.

Inspecting Starkeep cloud data

  Working directory: /Users/amkoller/projects/starkeep/starkeep-core. Cluster info lives in ~/.starkeep/config.json. Cached AWS creds (Cognito-minted, ~1h TTL) at ~/.starkeep/cloud-credentials.json
  — these assume starkeep-app-admin-role and can role-chain to starkeep-manager-role from there.

  Sync status (local supervisor's view)

  # HMAC = sha256(secret, "${appId}:${body}"). For GETs body is empty.
  APP=local-data-sync
  SECRET=$(sqlite3 ~/.starkeep/data.db "SELECT hmac_secret FROM shared_app_registry WHERE app_id='$APP'")
  SIG=$(node -e "console.log(require('crypto').createHmac('sha256','$SECRET').update('$APP:').digest('hex'))")
  curl -s -H "X-Starkeep-App-Id: $APP" -H "X-Starkeep-App-Sig: $SIG" http://localhost:9820/sync/status | python3 -m json.tool

  For POST /sync/now, body is {} and HMAC input is "$APP:{}".

  Local change log (what's queued to push)

  sqlite3 ~/.starkeep/data.db "SELECT json_extract(record_snapshot_json,'\$.originAppId') as origin, COUNT(*) FROM sync_change_log GROUP BY origin"
  sqlite3 ~/.starkeep/data.db "SELECT key, substr(value_json,1,200) FROM sync_state"  # push/pull cursors per app

  Cloud-side DSQL inspection (PG roles, IAM mappings, grants)

  Use the helper scripts in packages/admin-installer/scripts/. They briefly attach dsql:DbConnectAdmin to install-ddl-role and clean it up on exit.

  # Dump PG roles + sys.iam_pg_role_mappings + schemas; pass --app for an app's grants
  pnpm -F @starkeep/admin-installer debug:dsql-inspect --app local-data-sync

  # Reproduce what the cloud Lambda does when handling /apps/<appId>/sync/pull:
  # assume cds → assume app → DbConnect token → connect as starkeep_app_<appId>.
  # Shows DSQL hint field on failure (distinguishes IAM-action mismatch from
  # missing AWS IAM GRANT vs other failures).
  pnpm -F @starkeep/admin-installer debug:dsql-as-app local-data-sync

  Cloud Lambda logs (the handler that serves /apps/<appId>/sync/*)

  aws logs tail /aws/lambda/starkeep-app-cloud-data-server-api --region us-east-2 --since 10m --format short \
    | grep -E "Handler error|access denied|<appId>"
  aws lambda get-function-configuration --function-name starkeep-app-cloud-data-server-api \
    --region us-east-2 --query '{LastModified:LastModified,CodeSha:CodeSha256}'

  Key gotchas learned the hard way

  - DSQL's IAM auth needs an explicit AWS IAM GRANT "<pg_role>" TO '<iam-arn>' (separate from PG GRANT). Mappings live in sys.iam_pg_role_mappings. Missing mapping → FATAL 28000 / "unable to accept
  connection, access denied" with no hint — opaque on purpose.
  - DSQL SET name = $1 doesn't accept bind parameters; use SELECT set_config('name', $1, false).
  - cli-install-cloud-data-server now builds dist.zip itself, but if a Lambda code change isn't visible after install, check Lambda.LastModified — Pulumi silently skips when the zip hash matches.
  - "Successful" Lambda log entries (sub-second START/END with no output) are usually OPTIONS preflights or short-circuits, not real DB requests. Don't read them as proof DSQL works.
  - The local-data-server's /sync/status and /sync/now are per-app and only see changes whose originAppId matches the calling app. Records originated by an app that isn't installed in the cloud
  (e.g. photos, @starkeep/watcher) will never push through the local-data-sync channel even if the channel itself is healthy.
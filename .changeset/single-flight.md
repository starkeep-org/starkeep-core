---
"@starkeep/storage-aurora-dsql": minor
---

`guardSingleFlight` wraps a DSQL client and flags a statement that starts while another is still running on the same client. In `"throw"` mode it refuses the statement; in `"warn"` mode it logs `[pg-overlap]` with the stack once per call site and lets `pg` queue the statement. `pg` 8 queues such statements with a stackless deprecation warning, and `pg` 9 will refuse them.

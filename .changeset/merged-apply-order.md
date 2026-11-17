---
"@starkeep/sync-engine": patch
---

The responder applies a shipment per author in HLC order across app rows, records and labels together, as the requester already did; both sides now group and sort through one module, `inbound-order.ts`. It used to apply every record before any label, and each write raises its author's coverage, so a label whose HLC sat below one of the records was briefly claimed by the cloud's coverage before it landed. A round that died in that window, or another device that synced in it, lost the label for good. An app row that fails still halts its author for the round, but now at the row that failed: what lies below it stays applied, where before every record and label from that author was skipped.

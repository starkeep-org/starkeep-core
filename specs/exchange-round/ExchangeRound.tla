--------------------------- MODULE ExchangeRound ---------------------------
(***************************************************************************)
(* The Drive channel's /sync/exchange round between devices and the cloud. *)
(*                                                                         *)
(* What is modelled (see README.md for the action-to-code table):          *)
(*   - Two streams on one channel, shared records and record labels, each  *)
(*     an LWW table keyed by primary key and ordered by HLC.               *)
(*   - Devices write single rows or batches sharing one HLC (a label       *)
(*     batch is stamped with a single clock.now()).                        *)
(*   - A device's round: delta scan of each stream above the peer's        *)
(*     coverage (collectSince, per-author share, HLC-boundary trim with    *)
(*     widening), ceilings as the minimum over streams (computeCeilings),  *)
(*     cut in whole timestamps under the item budget (cutRound).           *)
(*   - The cloud responder applies the shipment ONE STATEMENT AT A TIME,   *)
(*     as DSQL does (each put is its own transaction and raises the        *)
(*     author's high-water coverage entry in node-watermarks.ts), then     *)
(*     scans, cuts and reports coverage.                                   *)
(*   - Rounds of different devices interleave freely on the cloud.         *)
(*   - The cloud Lambda can die, or the response can be lost, at any point *)
(*     after the round starts.                                             *)
(*   - Pull-only rounds (sync() pulls first whenever it owes the peer).    *)
(*   - Apply failures, bounded by MaxHalts and MaxDeviceFails. The cloud   *)
(*     halts the failed row's author for the round and carries on with the *)
(*     others (haltedAuthors); the device carries on past the failed row   *)
(*     and holds that author's watermark below it (brokenAt).              *)
(*   - With DeviceApply = "rows", the device applies a response one row at *)
(*     a time, and its own writes and a crash can land in between.         *)
(*                                                                         *)
(* What is not modelled: app-syncable tables (a third stream behaves like  *)
(* the label stream), byte budgets (rows cost 0 bytes in both cuts),       *)
(* repair floors, digests, the uploader and bytes watermark,              *)
(* coverageComplete = FALSE, refusedAuthors,                               *)
(* keepLiveOnTombstone and stand-in re-authoring on the cloud, deletion    *)
(* (a tombstone is just another LWW version here).                         *)
(*                                                                         *)
(* HLCs are modelled as distinct naturals 1..MaxTime with an author per    *)
(* value. Equal HLCs only arise inside one batch, exactly as in the code   *)
(* (compareHLC breaks ties on nodeId). A write takes any unused value      *)
(* above everything its device has seen, which is what clock.receive and   *)
(* clock.now() guarantee; RealTimeHLC = TRUE narrows that to "the next     *)
(* value", which is much cheaper to check.                                 *)
(***************************************************************************)
EXTENDS Integers, FiniteSets, Sequences, TLC

CONSTANTS
  NumNodes,      \* devices; each is also an author
  NumRec,        \* primary keys in the records stream
  NumLab,        \* primary keys in the labels stream
  MaxTime,       \* HLC values 1..MaxTime; also bounds the number of writes
  MaxWrites,     \* write actions (a batch is one action)
  Limit,         \* request.limit = maxItems: per-stream scan limit and cut budget
  BatchMax,      \* most rows one write stamps with the same HLC
  MaxCrashes,    \* cloud crashes / lost responses
  Writers,       \* devices that write
  RealTimeHLC,   \* TRUE: each write takes the next HLC value
  MergedApply,   \* FALSE: responder applies all records, then all labels
                 \*        (in-process-transport.ts before fix B).
                 \* TRUE:  per author in HLC order across both streams, as
                 \*        docs/system-design.md describes (step 1, today).
  ApplyUnit,     \* "statement": every put is its own DSQL transaction (today).
                 \* "timestamp": all rows sharing one HLC commit together.
                 \* "deferred":  rows commit one at a time and raise nothing;
                 \*        the author's coverage is raised in a statement of its
                 \*        own once a whole HLC has been applied, and the cloud's
                 \*        scans never ship a row above its own coverage.
  DeviceApply,   \* "atomic": the device applies a whole response in one step.
                 \* "rows":   one row at a time (sync-engine.ts inbound loop),
                 \*        then the watermarks once every row has been tried.
  MaxHalts,      \* rows the cloud refuses (in-process-transport.ts step 1)
  MaxDeviceFails, \* rows the device refuses (sync-engine.ts markBroken)
  DeviceFails,   \* streams whose rows can fail on the device. In the code a
                 \*        record can (its put or metadata throws) and a label
                 \*        cannot, so {"rec"} is the code as written.
  BelowBroken,   \* FALSE: a failed row's author advances to the HLC of the
                 \*        last row tried before it (ownSafeAdvance before fix E).
                 \* TRUE:  only to the last HLC strictly below the failed
                 \*        row's, so no row sharing its HLC is claimed (today).
  GuardedWrite,  \* FALSE: the LWW check (get) and the write (put / putLabel)
                 \*        are separate transactions, and the write is an
                 \*        unconditional upsert (today).
                 \* TRUE:  the comparison and the write are one atomic step.
  \* Mutants. Each one breaks a single rule; TLC must catch every one.
  MutPerStreamCeiling, \* ceiling per stream instead of the minimum
  MutSplitTimestamps,  \* cutRound takes items, not whole timestamps
  MutNoTrim,           \* collectSince does not trim back to an HLC boundary
  MutNoCoverageCap     \* "deferred" without the cap on the cloud's scans

ASSUME ApplyUnit \in {"statement", "timestamp", "deferred"}
ASSUME DeviceApply \in {"atomic", "rows"}
ASSUME MaxDeviceFails > 0 => DeviceApply = "rows"
ASSUME ~GuardedWrite => ApplyUnit = "statement"
ASSUME NumNodes >= 1 /\ Limit >= 1 /\ BatchMax >= 1 /\ Writers \subseteq 1..NumNodes

Nodes   == 1..NumNodes
Keys    == 1..(NumRec + NumLab)
Stream(k) == IF k <= NumRec THEN "rec" ELSE "lab"
Streams == {"rec", "lab"}
ASSUME DeviceFails \subseteq Streams
KeysOf(s) == {k \in Keys : Stream(k) = s}
Times   == 0..MaxTime          \* 0: no row / no coverage
Inf     == MaxTime + 1         \* "no ceiling"
Items   == Keys \X (1..MaxTime) \* a row version: <<primary key, HLC>>

VARIABLES
  author,   \* [1..MaxTime -> 0..NumNodes]: who minted each HLC (0 = unused)
  nwrites,  \* write actions so far
  written,  \* history: every row version ever written
  db,       \* db[n][k]: HLC of the version device n holds (0 = none)
  own,      \* own[n][a]: device n's rows watermark (setWatermarks)
  peer,     \* peer[n][a]: device n's cache of the cloud's coverage (setPeerWatermarks)
  cdb,      \* cdb[k]: HLC of the version the cloud holds
  cwm,      \* cwm[a]: cloud coverage = union over both node_watermarks tables
  pc,       \* pc[n]: "idle" | "applying" | "responded" | "receiving"
  queue,    \* queue[n]: device n's shipment, not yet applied by the cloud
  rd,       \* rd[n]: what the cloud's get returned for the head item (-1: no read yet)
  pr,       \* pr[n]: an HLC whose coverage raise is due ("deferred" only; 0: none)
  resp,     \* resp[n]: the cloud's response to device n
  crashes,
  inbox,    \* inbox[n]: rows of the response device n has still to try ("rows" only)
  adv,      \* adv[n][a]: HLC of a's last row tried before its first failure (ownSafeAdvance)
  brk,      \* brk[n]: authors with a failed row this response (brokenAt)
  halts,    \* rows the cloud has refused so far
  dfails    \* rows devices have refused so far

vars == <<author, nwrites, written, db, own, peer, cdb, cwm, pc, queue, rd, pr, resp, crashes,
          inbox, adv, brk, halts, dfails>>

Max(S) == CHOOSE x \in S : \A y \in S : y <= x
Min(S) == CHOOSE x \in S : \A y \in S : x <= y
Author(t) == author[t]
Used == {t \in 1..MaxTime : author[t] # 0}

(***************************************************************************)
(* Delta scan of one stream: storage-adapter since-queries.ts              *)
(***************************************************************************)

\* Rows of stream s, by author a, above the peer's watermark W[a].
Owed(T, W, s, a) == {k \in KeysOf(s) : T[k] > 0 /\ Author(T[k]) = a /\ T[k] > W[a]}
OwingAuthors(T, W, s) == {a \in Nodes : Owed(T, W, s, a) # {}}

\* collectSince: share = max(1, ceil(limit / authors owing)).
Share(T, W, s) ==
  LET c == Cardinality(OwingAuthors(T, W, s))
  IN  IF c = 0 THEN Limit ELSE (Limit + c - 1) \div c

\* SQL "ORDER BY updated_at" is stable only up to ties; break them on the key.
Before(T, j, k) == T[j] < T[k] \/ (T[j] = T[k] /\ j < k)
FirstN(T, ks, w) == {k \in ks : Cardinality({j \in ks : Before(T, j, k)}) < w}
CountLe(T, ks, h) == Cardinality({k \in ks : T[k] <= h})

\* One author's slice: [keep |-> keys returned, trunc |-> ceiling or Inf].
\* "page.length <= window" means complete; otherwise trimToHlcBoundary
\* drops the trailing run sharing an HLC with the first row not returned,
\* and an empty result doubles the window.
RECURSIVE Collect(_, _, _)
Collect(T, ks, w) ==
  IF Cardinality(ks) <= w THEN [keep |-> ks, trunc |-> Inf]
  ELSE IF MutNoTrim
       THEN LET f == FirstN(T, ks, w) IN [keep |-> f, trunc |-> Max({T[k] : k \in f})]
       ELSE LET fits == {h \in {T[k] : k \in ks} : CountLe(T, ks, h) <= w}
            IN  IF fits = {} THEN Collect(T, ks, 2 * w)
                ELSE LET c == Max(fits)
                     IN  [keep |-> {k \in ks : T[k] <= c}, trunc |-> c]

Scan(T, W, s) ==
  [a \in Nodes |-> IF Owed(T, W, s, a) = {} THEN [keep |-> {}, trunc |-> Inf]
                   ELSE Collect(T, Owed(T, W, s, a), Share(T, W, s))]

(***************************************************************************)
(* The cut: sync-engine round-cut.ts                                       *)
(***************************************************************************)

\* computeCeilings: the minimum across streams (Inf = absent = complete).
Ceiling(scans, a) == Min({scans[s][a].trunc : s \in Streams})

Eligible(T, W, cap) ==
  LET scans == [s \in Streams |-> Scan(T, W, s)]
      cand  == UNION {scans[s][a].keep : s \in Streams, a \in Nodes}
  IN  {k \in cand : T[k] <= cap[Author(T[k])] /\
         IF MutPerStreamCeiling
         THEN T[k] <= scans[Stream(k)][Author(T[k])].trunc
         ELSE T[k] <= Ceiling(scans, Author(T[k]))}

\* cutRound: earliest first, whole timestamps, the first group always goes.
Cut(T, E) ==
  IF E = {} THEN {}
  ELSE IF MutSplitTimestamps THEN FirstN(T, E, Limit)
  ELSE LET H  == {T[k] : k \in E}
           ok == {h \in H : CountLe(T, E, h) <= Limit}
           cutoff == IF ok = {} THEN Min(H) ELSE Max(ok)
       IN  {k \in E : T[k] <= cutoff}

NoCap == [a \in Nodes |-> Inf]
ShipmentCapped(T, W, cap) == {<<k, T[k]>> : k \in Cut(T, Eligible(T, W, cap))}
Shipment(T, W) == ShipmentCapped(T, W, NoCap)
\* What the cloud ships: with "deferred", nothing above its own coverage, so a
\* row whose HLC has not finished applying is invisible to every reader.
CloudShipment(W) ==
  IF ApplyUnit = "deferred" /\ ~MutNoCoverageCap
  THEN ShipmentCapped(cdb, W, cwm) ELSE Shipment(cdb, W)

(***************************************************************************)
(* Apply order on the responder                                            *)
(***************************************************************************)

SRank(k) == IF Stream(k) = "rec" THEN 0 ELSE 1
\* Sort key of an item, compared lexicographically.
OrderKey(it) ==
  IF MergedApply
  THEN <<Author(it[2]), it[2], SRank(it[1]), it[1]>>
  ELSE <<SRank(it[1]), Author(it[2]), it[2], it[1]>>
LexLess(x, y) ==
  \E i \in 1..Len(x) : x[i] < y[i] /\ \A j \in 1..(i - 1) : x[j] = y[j]

\* The requester always applies in merged per-author order (sync-engine.ts).
MergedKey(it) == <<Author(it[2]), it[2], SRank(it[1]), it[1]>>
RECURSIVE SortMerged(_)
SortMerged(S) ==
  IF S = {} THEN << >>
  ELSE LET m == CHOOSE x \in S : \A y \in S \ {x} : LexLess(MergedKey(x), MergedKey(y))
       IN  <<m>> \o SortMerged(S \ {m})

RECURSIVE SortItems(_)
SortItems(S) ==
  IF S = {} THEN << >>
  ELSE LET m == CHOOSE x \in S : \A y \in S \ {x} : LexLess(OrderKey(x), OrderKey(y))
       IN  <<m>> \o SortItems(S \ {m})

(***************************************************************************)
(* Actions                                                                 *)
(***************************************************************************)

Init ==
  /\ author  = [t \in 1..MaxTime |-> 0]
  /\ nwrites = 0
  /\ written = {}
  /\ db      = [n \in Nodes |-> [k \in Keys |-> 0]]
  /\ own     = [n \in Nodes |-> [a \in Nodes |-> 0]]
  /\ peer    = [n \in Nodes |-> [a \in Nodes |-> 0]]
  /\ cdb     = [k \in Keys |-> 0]
  /\ cwm     = [a \in Nodes |-> 0]
  /\ pc      = [n \in Nodes |-> "idle"]
  /\ queue   = [n \in Nodes |-> << >>]
  /\ rd      = [n \in Nodes |-> -1]
  /\ pr      = [n \in Nodes |-> 0]
  /\ resp    = [n \in Nodes |-> [items |-> {}, cov |-> [a \in Nodes |-> 0]]]
  /\ crashes = 0
  /\ inbox   = [n \in Nodes |-> << >>]
  /\ adv     = [n \in Nodes |-> [a \in Nodes |-> 0]]
  /\ brk     = [n \in Nodes |-> {}]
  /\ halts   = 0
  /\ dfails  = 0

\* An app on device n writes the rows S under one HLC t. clock.now() is above
\* everything the device holds, because every applied row went through
\* clock.receive.
Write(n, S, t) ==
  /\ n \in Writers
  /\ nwrites < MaxWrites
  /\ author[t] = 0
  /\ \A k \in Keys : t > db[n][k]
  /\ RealTimeHLC => \A u \in Used : t > u
  /\ author'  = [author EXCEPT ![t] = n]
  /\ nwrites' = nwrites + 1
  /\ written' = written \cup {<<k, t>> : k \in S}
  /\ db'      = [db EXCEPT ![n] = [k \in Keys |-> IF k \in S THEN t ELSE @[k]]]
  /\ UNCHANGED <<own, peer, cdb, cwm, pc, queue, rd, pr, resp, crashes, inbox, adv, brk, halts, dfails>>

\* sync-engine.ts exchange(): scan, cut, send. A pull-only round
\* (push = FALSE) ships nothing.
Start(n, push) ==
  /\ pc[n] = "idle"
  /\ pc'    = [pc EXCEPT ![n] = "applying"]
  /\ queue' = [queue EXCEPT ![n] =
                 IF push THEN SortItems(Shipment(db[n], peer[n])) ELSE << >>]
  /\ UNCHANGED <<author, nwrites, written, db, own, peer, cdb, cwm, rd, pr, resp, crashes, inbox, adv, brk, halts, dfails>>

\* in-process-transport.ts step 1: one put, LWW on HLC. A put that wins
\* raises its author's coverage entry in the same transaction
\* (node-watermarks.ts buildWatermarkRaises); one that loses records nothing.
\* With ApplyUnit = "timestamp" the head item and every item after it sharing
\* its HLC commit as one transaction.
ApplyOne(k, t, c) ==
  IF t > c[k] THEN [c EXCEPT ![k] = t] ELSE c

RECURSIVE ApplyAll(_, _)
ApplyAll(items, c) ==
  IF items = << >> THEN c
  ELSE ApplyAll(Tail(items), ApplyOne(Head(items)[1], Head(items)[2], c))

\* Length of the run at the head of q sharing the head's HLC.
RECURSIVE RunLen(_, _)
RunLen(q, t) == IF q = << >> \/ Head(q)[2] # t THEN 0 ELSE 1 + RunLen(Tail(q), t)

CloudApply(n) ==
  /\ GuardedWrite
  /\ pc[n] = "applying"
  /\ queue[n] # << >>
  /\ pr[n] = 0
  /\ LET t     == Head(queue[n])[2]
         len   == IF ApplyUnit = "timestamp" THEN RunLen(queue[n], t) ELSE 1
         batch == SubSeq(queue[n], 1, len)
         c2    == ApplyAll(batch, cdb)
         landed == \E i \in 1..len : c2[batch[i][1]] = t /\ cdb[batch[i][1]] < t
     IN  /\ cdb' = c2
         /\ cwm' = IF ApplyUnit # "deferred" /\ landed /\ t > cwm[Author(t)]
                   THEN [cwm EXCEPT ![Author(t)] = t] ELSE cwm
         /\ queue' = [queue EXCEPT ![n] = SubSeq(@, len + 1, Len(@))]
         \* The last row of an HLC: its raise is due, whether or not the rows
         \* landed (a re-shipped row that is already there still completes it).
         /\ pr' = IF ApplyUnit = "deferred"
                     /\ (len = Len(queue[n]) \/ queue[n][len + 1][2] # t)
                  THEN [pr EXCEPT ![n] = t] ELSE pr
  /\ UNCHANGED <<author, nwrites, written, db, own, peer, pc, rd, resp, crashes, inbox, adv, brk, halts, dfails>>

\* in-process-transport.ts step 1: an app row that fails, or names an app the
\* cloud does not know, halts its author for the round. The model lets any row
\* fail this way, which admits more behaviours than the code has (a record or
\* label that throws aborts the exchange instead, which is Crash). The halted
\* author's remaining rows are dropped from the shipment; every other author's
\* rows still apply, and the response reports coverage as usual.
CloudHalt(n) ==
  /\ pc[n] = "applying"
  /\ queue[n] # << >>
  /\ pr[n] = 0
  /\ rd[n] = -1
  /\ halts < MaxHalts
  /\ LET a == Author(Head(queue[n])[2])
     IN  queue' = [queue EXCEPT ![n] = SelectSeq(@, LAMBDA it : Author(it[2]) # a)]
  /\ halts' = halts + 1
  /\ UNCHANGED <<author, nwrites, written, db, own, peer, cdb, cwm, pc, rd, pr, resp, crashes,
                 inbox, adv, brk, dfails>>

\* "deferred": the coverage raise, its own statement after the HLC's rows.
CloudRaise(n) ==
  /\ pr[n] # 0
  /\ cwm' = [cwm EXCEPT ![Author(pr[n])] = IF pr[n] > @ THEN pr[n] ELSE @]
  /\ pr'  = [pr EXCEPT ![n] = 0]
  /\ UNCHANGED <<author, nwrites, written, db, own, peer, cdb, pc, queue, rd, resp, crashes, inbox, adv, brk, halts, dfails>>

\* Today's apply, in two transactions: `databaseAdapter.get` (or getLabel),
\* the LWW comparison in JavaScript, then `put` (or putLabel), an upsert that
\* overwrites whatever the row holds by then. Another round may write the same
\* key in between.
CloudRead(n) ==
  /\ ~GuardedWrite
  /\ pc[n] = "applying"
  /\ queue[n] # << >>
  /\ rd[n] = -1
  /\ rd' = [rd EXCEPT ![n] = cdb[Head(queue[n])[1]]]
  /\ UNCHANGED <<author, nwrites, written, db, own, peer, cdb, cwm, pc, queue, pr, resp, crashes, inbox, adv, brk, halts, dfails>>

CloudWrite(n) ==
  /\ ~GuardedWrite
  /\ pc[n] = "applying"
  /\ rd[n] # -1
  /\ LET k == Head(queue[n])[1]
         t == Head(queue[n])[2]
     IN  IF t > rd[n]
         THEN /\ cdb' = [cdb EXCEPT ![k] = t]
              /\ cwm' = [cwm EXCEPT ![Author(t)] = IF t > @ THEN t ELSE @]
         ELSE UNCHANGED <<cdb, cwm>>
  /\ queue' = [queue EXCEPT ![n] = Tail(@)]
  /\ rd'    = [rd EXCEPT ![n] = -1]
  /\ UNCHANGED <<author, nwrites, written, db, own, peer, pc, pr, resp, crashes, inbox, adv, brk, halts, dfails>>

\* in-process-transport.ts steps 2-4: scan above the requester's advertised
\* watermarks, cut, and report coverage over the post-apply state.
CloudRespond(n) ==
  /\ pc[n] = "applying"
  /\ queue[n] = << >>
  /\ pr[n] = 0
  /\ resp' = [resp EXCEPT ![n] = [items |-> CloudShipment(own[n]), cov |-> cwm]]
  /\ pc'   = [pc EXCEPT ![n] = "responded"]
  /\ UNCHANGED <<author, nwrites, written, db, own, peer, cdb, cwm, queue, rd, pr, crashes, inbox, adv, brk, halts, dfails>>

\* The Lambda dies mid-apply, or the response never arrives. Whatever was
\* applied stays applied; the device keeps its previous watermarks.
\* With DeviceApply = "rows", the device may also die while it applies the
\* response: the rows it wrote stay written, and no watermark moves.
Crash(n) ==
  /\ pc[n] \in {"applying", "responded", "receiving"}
  /\ crashes < MaxCrashes
  /\ pc'      = [pc EXCEPT ![n] = "idle"]
  /\ queue'   = [queue EXCEPT ![n] = << >>]
  /\ rd'      = [rd EXCEPT ![n] = -1]
  /\ pr'      = [pr EXCEPT ![n] = 0]
  /\ inbox'   = [inbox EXCEPT ![n] = << >>]
  /\ crashes' = crashes + 1
  /\ UNCHANGED <<author, nwrites, written, db, own, peer, cdb, cwm, resp, adv, brk, halts, dfails>>

\* sync-engine.ts inbound: LWW apply, advance the own watermark per author to
\* the last item applied (ownSafeAdvance), replace the peer cache with the
\* responder's coverage (coverageComplete is always TRUE here).
Receive(n) ==
  /\ DeviceApply = "atomic"
  /\ pc[n] = "responded"
  /\ LET its == resp[n].items
     IN  /\ db'  = [db EXCEPT ![n] =
                     [k \in Keys |->
                        LET in == {it[2] : it \in {i \in its : i[1] = k}}
                        IN  IF in # {} /\ Max(in) > @[k] THEN Max(in) ELSE @[k]]]
         /\ own' = [own EXCEPT ![n] =
                     [a \in Nodes |->
                        Max({@[a]} \cup {it[2] : it \in {i \in its : Author(i[2]) = a}})]]
  /\ peer' = [peer EXCEPT ![n] = resp[n].cov]
  /\ pc'   = [pc EXCEPT ![n] = "idle"]
  /\ UNCHANGED <<author, nwrites, written, cdb, cwm, queue, rd, pr, resp, crashes, inbox, adv, brk, halts, dfails>>

\* DeviceApply = "rows": the same, one row at a time. ReceiveStart sorts the
\* response per author in HLC order; ReceiveRow writes one row under LWW (a
\* guarded write, as fix A made it, so a local write in between is never
\* overwritten); ReceiveFail refuses one row (a record whose put throws, an
\* app row the applier rejects) and the loop carries on past it. ReceiveEnd
\* saves the watermarks: each author's own watermark advances to the HLC of
\* the last row tried before its first failure, or with BelowBroken only to
\* the last HLC below the failed row's (ownSafeAdvance).
ReceiveStart(n) ==
  /\ DeviceApply = "rows"
  /\ pc[n] = "responded"
  /\ pc'    = [pc EXCEPT ![n] = "receiving"]
  /\ inbox' = [inbox EXCEPT ![n] = SortMerged(resp[n].items)]
  /\ adv'   = [adv EXCEPT ![n] = [a \in Nodes |-> 0]]
  /\ brk'   = [brk EXCEPT ![n] = {}]
  /\ UNCHANGED <<author, nwrites, written, db, own, peer, cdb, cwm, queue, rd, pr, resp, crashes,
                 halts, dfails>>

ReceiveRow(n) ==
  /\ pc[n] = "receiving"
  /\ inbox[n] # << >>
  /\ LET k == Head(inbox[n])[1]
         t == Head(inbox[n])[2]
         a == Author(t)
     IN  /\ db'  = [db EXCEPT ![n][k] = IF t > @ THEN t ELSE @]
         /\ adv' = IF a \in brk[n] THEN adv ELSE [adv EXCEPT ![n][a] = t]
  /\ inbox' = [inbox EXCEPT ![n] = Tail(@)]
  /\ UNCHANGED <<author, nwrites, written, own, peer, cdb, cwm, pc, queue, rd, pr, resp, crashes,
                 brk, halts, dfails>>

ReceiveFail(n) ==
  /\ pc[n] = "receiving"
  /\ inbox[n] # << >>
  /\ dfails < MaxDeviceFails
  /\ LET k == Head(inbox[n])[1]
         t == Head(inbox[n])[2]
         a == Author(t)
         \* Every row of a below t was tried before this one: the inbox is sorted.
         below == Max({0} \cup {it[2] : it \in {i \in resp[n].items : Author(i[2]) = a /\ i[2] < t}})
     IN  /\ Stream(k) \in DeviceFails
         /\ brk' = [brk EXCEPT ![n] = @ \cup {a}]
         /\ adv' = IF BelowBroken /\ a \notin brk[n] THEN [adv EXCEPT ![n][a] = below] ELSE adv
  /\ inbox'  = [inbox EXCEPT ![n] = Tail(@)]
  /\ dfails' = dfails + 1
  /\ UNCHANGED <<author, nwrites, written, db, own, peer, cdb, cwm, pc, queue, rd, pr, resp, crashes,
                 halts>>

ReceiveEnd(n) ==
  /\ pc[n] = "receiving"
  /\ inbox[n] = << >>
  /\ own'  = [own EXCEPT ![n] = [a \in Nodes |-> IF adv[n][a] > @[a] THEN adv[n][a] ELSE @[a]]]
  /\ peer' = [peer EXCEPT ![n] = resp[n].cov]
  /\ pc'   = [pc EXCEPT ![n] = "idle"]
  /\ UNCHANGED <<author, nwrites, written, db, cdb, cwm, queue, rd, pr, resp, crashes,
                 inbox, adv, brk, halts, dfails>>

Next ==
  \/ \E n \in Nodes, t \in 1..MaxTime, S \in SUBSET Keys :
        S # {} /\ Cardinality(S) <= BatchMax /\ Write(n, S, t)
  \/ \E n \in Nodes, push \in BOOLEAN : Start(n, push)
  \/ \E n \in Nodes : \/ CloudApply(n) \/ CloudRead(n) \/ CloudWrite(n) \/ CloudRaise(n)
                     \/ CloudRespond(n) \/ Crash(n) \/ Receive(n) \/ CloudHalt(n)
                     \/ ReceiveStart(n) \/ ReceiveRow(n) \/ ReceiveFail(n) \/ ReceiveEnd(n)

Spec == Init /\ [][Next]_vars

(***************************************************************************)
(* Invariants                                                              *)
(***************************************************************************)

TypeOK ==
  /\ author \in [1..MaxTime -> 0..NumNodes]
  /\ written \subseteq Items
  /\ db \in [Nodes -> [Keys -> Times]]
  /\ own \in [Nodes -> [Nodes -> Times]]
  /\ peer \in [Nodes -> [Nodes -> Times]]
  /\ cdb \in [Keys -> Times]
  /\ cwm \in [Nodes -> Times]
  /\ pc \in [Nodes -> {"idle", "applying", "responded", "receiving"}]

\* A device's rows watermark never claims a version it lacks. The cloud ships
\* author a's rows only above own[n][a], so a claimed version that is missing
\* is never offered again: silent and permanent. The one escape is a newer
\* version of the same key that the watermark does not claim yet.
DeviceNoGap ==
  \A n \in Nodes, w \in written :
    LET k == w[1]  t == w[2]
    IN  (own[n][Author(t)] >= t /\ db[n][k] < t) =>
          \E w2 \in written :
            w2[1] = k /\ w2[2] > t /\ own[n][Author(w2[2])] < w2[2]

\* The cloud lacks a version only while somebody will still bring it: a
\* shipment in flight, or a device that holds an equal or newer version and
\* does not believe the cloud has it (so its next push ships it).
CloudNoLoss ==
  \A w \in written :
    LET k == w[1]  t == w[2]
    IN  cdb[k] < t =>
          \/ \E m \in Nodes : \E i \in 1..Len(queue[m]) :
               queue[m][i][1] = k /\ queue[m][i][2] >= t
          \/ \E m \in Nodes :
               db[m][k] >= t /\ peer[m][Author(db[m][k])] < db[m][k]

\* Coverage never runs ahead of the cloud's own holdings except while a
\* shipment is in flight. Not a loss on its own (see CloudNoLoss); this is the
\* window the losses come through. A version some newer version of the same
\* key supersedes is exempt: it never has to arrive, and the newer version is
\* checked in its own right.
CloudCoverageHonestAtRest ==
  (\A m \in Nodes : queue[m] = << >>) =>
    \A w \in written :
      (/\ cwm[Author(w[2])] >= w[2]
       /\ ~ \E w2 \in written : w2[1] = w[1] /\ w2[2] > w[2])
        => cdb[w[1]] >= w[2]

(***************************************************************************)
(* Witnesses: list one as an INVARIANT and TLC must report it violated,    *)
(* which proves the milestone is reachable and a clean run is not vacuous. *)
(***************************************************************************)
WitnessRelayedLabel ==
  ~ \E n \in Nodes, k \in KeysOf("lab") : db[n][k] > 0 /\ Author(db[n][k]) # n
WitnessTruncatedRound ==
  ~ \E n \in Nodes : pc[n] = "applying" /\ Len(queue[n]) > 0
        /\ Shipment(db[n], peer[n]) # {<<k, db[n][k]>> : k \in {j \in Keys : db[n][j] > 0
                                         /\ db[n][j] > peer[n][Author(db[n][j])]}}
WitnessBatchDelivered ==
  ~ \E n \in Nodes, j, k \in Keys :
        j # k /\ db[n][j] > 0 /\ db[n][j] = db[n][k] /\ Author(db[n][j]) # n
WitnessCrash == crashes = 0
WitnessHalt == halts = 0
WitnessDeviceFail == dfails = 0
\* Every write reaches every device and the cloud after a refusal on each side.
WitnessConvergedAfterFailures ==
  ~ (/\ halts = MaxHalts /\ dfails = MaxDeviceFails
     /\ nwrites = MaxWrites
     /\ \A n \in Nodes : pc[n] = "idle" /\ db[n] = cdb
     /\ \A w \in written : cdb[w[1]] >= w[2])
WitnessAllConverged ==
  ~ (/\ nwrites = MaxWrites
     /\ \A n \in Nodes : pc[n] = "idle" /\ db[n] = cdb
     /\ \A w \in written : cdb[w[1]] >= w[2])
=============================================================================

/**
 * Content-addressed record ids.
 *
 * ## Why these exist
 *
 * `shared_records` enforces a natural-key uniqueness constraint over live rows,
 * and it is replicated multi-master. Those two facts cannot both hold while
 * rows are keyed on a surrogate each node mints independently: two nodes that
 * produce the same file — two devices importing one SD card, or two nodes
 * deriving the same rendition from a shared original — each mint their own
 * ULID, and whichever row arrives second is refused by the index. That refusal
 * escapes the exchange loop and stops the app's sync entirely.
 *
 * Enforcing a uniqueness constraint on a natural key requires either
 * coordination between writers or that the natural key *is* the key. This is
 * the second. Two nodes producing the same file now produce the same row, and
 * `put`'s `ON CONFLICT (id) DO UPDATE` merges them under ordinary LWW instead of
 * raising. The collision stops being a case to handle and becomes one that
 * cannot arise.
 *
 * ## What goes into the id
 *
 * Exactly the columns the constraint names — `(parent_id, original_filename,
 * content_hash)` — and nothing else. Adding anything the index does not cover
 * would let two rows the index considers the same receive different ids, which
 * is the bug this removes; leaving anything out would merge rows the index
 * considers distinct, which is data loss.
 *
 * **`parent_id` is in the key because the store cannot represent a shared
 * child.** `parent_id` is one scalar column on the child row, so two records
 * that derive byte-identical output under one name do not come to share a
 * child — the second write silently overwrites the first record's parentage and
 * the first original loses its derived file. Naming discipline does not avoid
 * this: Photos names a rendition after its parent's *filename*, and two
 * distinct originals are allowed to carry one filename, so two imports of one
 * photo differing only in stripped EXIF already produce byte-identical
 * renditions under one name.
 *
 * Parentage is safe to put in an identity because `parent_id` means "derived
 * from" rather than "contained in". Derivation is a fact about how bytes came
 * to exist and cannot legitimately change, so no reparent path is being closed.
 *
 * A record with no filename is content-addressed too. The two indexes treat a
 * missing filename as a value rather than as an unknown — SQLite through
 * `COALESCE`, DSQL through `NULLS NOT DISTINCT` — so nameless rows fall under
 * the constraint and have to converge like any other.
 *
 * ## Why a null parent takes the shorter form
 *
 * A top-level record hashes `(filename, hash)` and a child hashes
 * `(parent, filename, hash)`. The shorter form is not a case to tolerate: it
 * keeps every top-level id that predates `parent_id` joining the key, so no
 * shipped row re-mints and no upgrade collides with itself. Children may
 * re-mint safely, because registration dedups on `(parent_id, content_hash)`
 * and returns the existing row before any insert is attempted.
 *
 * The two forms cannot collide. A separator-joined top-level input carries
 * exactly one NUL and a child input carries exactly two, and none of the three
 * fields can contain one.
 *
 * ## Shape
 *
 * 26 characters of Crockford base32, so `isStarkeepId` and every column, index
 * and wire format that already carries a ULID carries this unchanged.
 *
 * The leading character is `Z`, which a ULID cannot begin with: a ULID's first
 * character encodes the top bits of a 48-bit millisecond timestamp and so never
 * exceeds `7`. That makes the two kinds tellable apart on sight in a log or a
 * database, and it means these ids sort after every ULID rather than
 * interleaving with them — so a store holding both pages through its existing
 * records in their original order before reaching any of these.
 *
 * The remaining 25 characters carry 125 bits of a SHA-256 over the natural key.
 * A ULID carries 80 bits of randomness, so this is the stronger of the two
 * guarantees against accidental collision.
 */

import { sha256 } from "@noble/hashes/sha2";
import type { StarkeepId } from "./types.js";
import { createStarkeepId } from "./types.js";

/** Crockford base32 — the ULID alphabet, so both kinds of id share a charset. */
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * Marks an id as content-addressed rather than minted.
 *
 * `Z` is unreachable as a ULID's first character, so this is a real
 * discriminator rather than a convention a ULID might accidentally satisfy.
 */
export const CONTENT_ID_PREFIX = "Z";

/** How many characters carry hash bits. The first carries the prefix. */
const HASH_CHARS = 25;

/**
 * Separator between the inputs.
 *
 * NUL, because none of a record id, a filename or a hex digest can contain one
 * — so `("ab", "c")` and `("a", "bc")` cannot hash to the same id, and a
 * two-field input can never read as a three-field one.
 */
const SEPARATOR = "\u0000";

/** Big-endian, five bits at a time over the digest. */
function encodeCrockford(bytes: Uint8Array, chars: number): string {
  let out = "";
  let buffer = 0;
  let bits = 0;
  let next = 0;
  while (out.length < chars) {
    while (bits < 5) {
      buffer = (buffer << 8) | (bytes[next++] ?? 0);
      bits += 8;
    }
    bits -= 5;
    out += CROCKFORD[(buffer >> bits) & 31];
  }
  return out;
}

/**
 * The id of the record holding these bytes under this name and this parent, on
 * any node.
 *
 * A child id is only agreed between nodes when the parent id is agreed. That
 * holds for every record: rows predating this scheme carry one id because sync
 * gave both nodes the same row, and rows minted under it are content-addressed
 * all the way up.
 */
export function contentAddressedId(
  parentId: string | null,
  originalFilename: string | null,
  contentHash: string,
): StarkeepId {
  const fields =
    parentId === null
      ? [originalFilename ?? "", contentHash]
      : [parentId, originalFilename ?? "", contentHash];
  const digest = sha256(new TextEncoder().encode(fields.join(SEPARATOR)));
  return createStarkeepId(CONTENT_ID_PREFIX + encodeCrockford(digest, HASH_CHARS));
}

/**
 * Whether this id names its own content.
 *
 * Answers "would two nodes have agreed on this id", which is what a caller
 * reasoning about convergence wants to know. Records predating this scheme
 * answer false.
 */
export function isContentAddressedId(id: string): boolean {
  return id.length === 26 && id.startsWith(CONTENT_ID_PREFIX);
}

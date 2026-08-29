/**
 * Content-addressed record ids.
 *
 * ## Why these exist
 *
 * `shared_records` enforces `UNIQUE(original_filename, content_hash)` over live
 * rows, and it is replicated multi-master. Those two facts cannot both hold
 * while rows are keyed on a surrogate each node mints independently: two nodes
 * that produce the same file — two devices importing one SD card, or two nodes
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
 * Exactly the columns the constraint names, and nothing else. Adding anything
 * the index does not cover would let two rows the index considers the same
 * receive different ids, which is the bug this removes; leaving anything out
 * would merge rows the index considers distinct, which is data loss.
 *
 * A record with no filename is not covered by the constraint at all — the index
 * is partial, `WHERE original_filename IS NOT NULL` — so it keeps a ULID. That
 * is a property of the row rather than a judgement an app makes about its own
 * data, which matters: an app that had to classify its own writes would
 * eventually classify one wrong, and the symptom would be a silent sync stall.
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
 * Separator between the two inputs.
 *
 * NUL, because neither a filename nor a hex digest can contain one — so
 * `("ab", "c")` and `("a", "bc")` cannot hash to the same id.
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
 * The id of the record holding these bytes under this name, on any node.
 */
export function contentAddressedId(
  originalFilename: string,
  contentHash: string,
): StarkeepId {
  const digest = sha256(
    new TextEncoder().encode(`${originalFilename}${SEPARATOR}${contentHash}`),
  );
  return createStarkeepId(CONTENT_ID_PREFIX + encodeCrockford(digest, HASH_CHARS));
}

/**
 * Whether this id names its own content.
 *
 * Answers "would two nodes have agreed on this id", which is what a caller
 * reasoning about convergence wants to know. Records predating this scheme, and
 * records with no filename, answer false.
 */
export function isContentAddressedId(id: string): boolean {
  return id.length === 26 && id.startsWith(CONTENT_ID_PREFIX);
}

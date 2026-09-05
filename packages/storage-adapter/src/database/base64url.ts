/**
 * Base64url over UTF-8 text, without `Buffer` and without any other global.
 *
 * ## Why this exists
 *
 * Every opaque cursor in this package is a JSON payload encoded to base64url,
 * and the encoding was `Buffer.from(…).toString("base64url")`. `Buffer` is a
 * Node global. This package runs in Node on both data servers **and under
 * Hermes on the phone**, where there is no `Buffer` and no polyfill for one —
 * so the first library page that had a second page to offer threw
 * `ReferenceError: Property 'Buffer' doesn't exist` and the grid rendered the
 * error instead of the photographs.
 *
 * `label-cursor.ts` had the same call and had not yet been caught by it, for a
 * reason that is luck rather than design: its cursor is null until a page fills,
 * so a phone whose label set fits in one page never reaches the encode. Both
 * modules use this now, so the hazard is gone rather than dormant.
 *
 * ## Why nothing is assumed
 *
 * Not `Buffer`, and not `TextEncoder`/`atob` either. The bug being fixed here
 * was caused by assuming a global was present; replacing one assumption with a
 * different one is the same mistake at a different address. React Native's
 * polyfill set has changed across versions and differs from Node's, and a
 * cursor is not worth a second round of this.
 *
 * So the UTF-8 conversion and the base64 alphabet are both written out. They are
 * small, they are decidable in Node, and they behave identically wherever this
 * package runs — which is the property a cursor actually needs, since a token
 * cut by a phone may be handed back to a cloud data server.
 *
 * ## Why base64url rather than base64
 *
 * The tokens travel in query strings. `+` and `/` do not survive that
 * unescaped, and `=` padding is noise in a value nothing but this module reads.
 */

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** Reverse of {@link ALPHABET}, built once. */
const VALUES: Record<string, number> = {};
for (let i = 0; i < ALPHABET.length; i += 1) VALUES[ALPHABET[i]!] = i;

/** UTF-8 bytes for a string, without `TextEncoder`. */
function utf8Bytes(text: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    let code = text.charCodeAt(i);
    // A surrogate pair is one code point in two units. Combining them here is
    // what keeps an emoji in a filename from encoding as two replacement
    // characters — and a cursor that does not round-trip its own input is a
    // cursor that silently skips a row.
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
        i += 1;
      }
    }
    if (code < 0x80) {
      out.push(code);
    } else if (code < 0x800) {
      out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code < 0x10000) {
      out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      out.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    }
  }
  return out;
}

/** The inverse of {@link utf8Bytes}, without `TextDecoder`. */
function utf8String(bytes: number[]): string {
  let out = "";
  let i = 0;
  while (i < bytes.length) {
    const byte = bytes[i]!;
    let code: number;
    if (byte < 0x80) {
      code = byte;
      i += 1;
    } else if ((byte & 0xe0) === 0xc0) {
      code = ((byte & 0x1f) << 6) | (bytes[i + 1]! & 0x3f);
      i += 2;
    } else if ((byte & 0xf0) === 0xe0) {
      code = ((byte & 0x0f) << 12) | ((bytes[i + 1]! & 0x3f) << 6) | (bytes[i + 2]! & 0x3f);
      i += 3;
    } else {
      code =
        ((byte & 0x07) << 18) |
        ((bytes[i + 1]! & 0x3f) << 12) |
        ((bytes[i + 2]! & 0x3f) << 6) |
        (bytes[i + 3]! & 0x3f);
      i += 4;
    }
    if (code > 0xffff) {
      const shifted = code - 0x10000;
      out += String.fromCharCode(0xd800 + (shifted >> 10), 0xdc00 + (shifted & 0x3ff));
    } else {
      out += String.fromCharCode(code);
    }
  }
  return out;
}

export function encodeBase64Url(text: string): string {
  const bytes = utf8Bytes(text);
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!;
    const b = i + 1 < bytes.length ? bytes[i + 1]! : -1;
    const c = i + 2 < bytes.length ? bytes[i + 2]! : -1;

    out += ALPHABET[a >> 2];
    out += ALPHABET[((a & 0x03) << 4) | (b < 0 ? 0 : b >> 4)];
    if (b < 0) break;
    out += ALPHABET[((b & 0x0f) << 2) | (c < 0 ? 0 : c >> 6)];
    if (c < 0) break;
    out += ALPHABET[c & 0x3f];
  }
  // No padding, deliberately — see the note above about query strings.
  return out;
}

/**
 * Returns `null` for anything that is not a token this module produced.
 *
 * Null rather than a throw, matching every caller's existing contract: a
 * hand-edited cursor gets the first page, not a 500.
 */
export function decodeBase64Url(token: string): string | null {
  const bytes: number[] = [];
  let accumulator = 0;
  let bits = 0;
  for (let i = 0; i < token.length; i += 1) {
    const value = VALUES[token[i]!];
    if (value === undefined) return null;
    accumulator = (accumulator << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((accumulator >> bits) & 0xff);
    }
  }
  try {
    return utf8String(bytes);
  } catch {
    return null;
  }
}

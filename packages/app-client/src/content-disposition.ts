/**
 * The `Content-Disposition` header for a file a server sends back.
 *
 * One construction for every site that names a downloaded file. Drive's file
 * route and the cloud data server's public links both call it, so a name with
 * a quote, a slash or a non-ASCII character comes out the same everywhere.
 *
 * Dependency-free, so the cloud data server's Lambda bundle and any app server
 * can import it.
 */

/**
 * The header value that names the file `name`.
 *
 * `inline` asks the browser to show the file and `attachment` asks it to
 * download. Either way the browser saves the file under `name` when it saves
 * it. Without a name the browser falls back to the URL's last segment, which
 * is how Drive downloads came to be called `file`.
 *
 * The name loses control characters, quotes, backslashes and slashes, and an
 * empty name becomes `download`. `filename` holds an ASCII fallback, and
 * `filename*` holds the UTF-8 form (RFC 6266, RFC 8187).
 */
export function contentDisposition(name: string, opts: { inline: boolean }): string {
  const safe = name.replace(/[\u0000-\u001f\u007f"\\/]/g, "_").trim() || "download";
  const ascii = safe.replace(/[^\x20-\x7e]/g, "_");
  const type = opts.inline ? "inline" : "attachment";
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encodeRfc8187(safe)}`;
}

/**
 * Percent-encode a value for an RFC 8187 `ext-value`, which admits fewer
 * characters than `encodeURIComponent` leaves alone.
 */
function encodeRfc8187(value: string): string {
  return encodeURIComponent(value).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

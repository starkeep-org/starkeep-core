/**
 * The viewer-request CloudFront function on the `/sites/*` behavior, which
 * serves each app's public site from the app assets bucket.
 *
 * CloudFront's request path becomes the S3 key, so the function rewrites
 * `/sites/<appId>/<path>` to `/apps/<appId>/_site/<path>`, where the installer
 * put the site's files. The installer's grants and the uninstall's delete
 * already cover `apps/<appId>/`, so a site needs no S3 prefix of its own.
 *
 * Three address rules, the ones static hosts use:
 *
 * - A path that ends in `/` serves that folder's `index.html`.
 * - A path whose last segment has no dot names a folder, so it redirects to
 *   the same path plus `/`. Relative links in the page then resolve against
 *   the folder rather than its parent.
 * - Any other path serves the file of that name.
 *
 * Kept in its own module, free of Pulumi, so a unit test can run the code.
 * The code stays ES5, which is what the existing functions use.
 */
export const SITE_PATHS_FUNCTION_CODE = `function handler(event) {
  var request = event.request;
  var uri = request.uri;

  // The id pattern matches the installer's cloud-installable app ids.
  var m = uri.match(/^\\/sites\\/([a-z0-9][a-z0-9._-]*)(\\/.*)?$/);
  if (!m) {
    return {
      statusCode: 404,
      statusDescription: "Not Found",
      headers: { "cache-control": { value: "public, max-age=60" } },
    };
  }
  var appId = m[1];
  var rest = m[2];

  if (!rest || (rest.charAt(rest.length - 1) !== "/" && rest.slice(rest.lastIndexOf("/") + 1).indexOf(".") === -1)) {
    return {
      statusCode: 301,
      statusDescription: "Moved Permanently",
      headers: {
        location: { value: uri + "/" + queryOf(request.querystring) },
        "cache-control": { value: "public, max-age=3600" },
      },
    };
  }
  if (rest.charAt(rest.length - 1) === "/") rest = rest + "index.html";

  request.uri = "/apps/" + appId + "/_site" + rest;
  return request;
}

function queryOf(qs) {
  var parts = [];
  for (var key in qs) {
    var entry = qs[key];
    var values = entry.multiValue ? entry.multiValue : [entry];
    for (var i = 0; i < values.length; i++) {
      var value = values[i].value;
      parts.push(value === "" ? key : key + "=" + value);
    }
  }
  return parts.length > 0 ? "?" + parts.join("&") : "";
}`;

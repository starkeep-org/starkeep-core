/**
 * The viewer-request CloudFront function on the `/sites/*` behavior, which
 * serves each app's public site from the app assets bucket.
 *
 * CloudFront's request path becomes the S3 key, so the function rewrites
 * `/sites/<appId>/<path>` to `/apps/<appId>/_site/<path>`, where the installer
 * put the site's files. The installer's grants and the uninstall's delete
 * already cover `apps/<appId>/`, so a site needs no S3 prefix of its own.
 *
 * Three address rules:
 *
 * - `/sites/<appId>` redirects to `/sites/<appId>/`, so relative links in the
 *   home page resolve inside the site.
 * - A path that ends in `/` serves that folder's `index.html`.
 * - Any other path serves the object of that name. For a file, that is the
 *   file, whatever its name: Flutter's `assets/NOTICES` has no extension. For
 *   a folder named without its slash, such as `about`, that is the page the
 *   installer wrote there, which moves the browser to `about/`. The function
 *   cannot tell a file from a folder, because it cannot see the bucket, so the
 *   installer, which knows the site's files, decides.
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

  if (!rest) {
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

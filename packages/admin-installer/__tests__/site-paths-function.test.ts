/**
 * The `/sites/*` viewer-request function, run as CloudFront runs it: the code
 * string evaluated on its own, called with a viewer-request event. The live
 * behavior is checked by the tier-3 public-site step.
 */
import { describe, it, expect } from "vitest";
import { SITE_PATHS_FUNCTION_CODE } from "../src/builtin-programs/site-paths-function";

type QueryString = Record<string, { value: string; multiValue?: { value: string }[] }>;

interface Rewritten {
  uri: string;
}
interface Answered {
  statusCode: number;
  headers: Record<string, { value: string }>;
}

const handler = new Function(`${SITE_PATHS_FUNCTION_CODE}\nreturn handler;`)() as (event: {
  request: { uri: string; querystring: QueryString };
}) => Rewritten | Answered;

function run(uri: string, querystring: QueryString = {}) {
  return handler({ request: { uri, querystring } });
}

describe("site-paths function", () => {
  // SITES-001
  it("serves a site's home page from its folder in the app assets bucket", () => {
    expect(run("/sites/blog/")).toMatchObject({ uri: "/apps/blog/_site/index.html" });
  });

  // SITES-002
  it("serves a subfolder's index.html for a path that ends in a slash", () => {
    expect(run("/sites/blog/about/")).toMatchObject({ uri: "/apps/blog/_site/about/index.html" });
  });

  it("serves a file by its name", () => {
    expect(run("/sites/blog/img/cat.png")).toMatchObject({ uri: "/apps/blog/_site/img/cat.png" });
    expect(run("/sites/blog/about.html")).toMatchObject({ uri: "/apps/blog/_site/about.html" });
  });

  // SITES-003
  it.each([
    ["/sites/blog", "/sites/blog/"],
    ["/sites/blog/about", "/sites/blog/about/"],
  ])("redirects %s to %s, so relative links resolve in the folder", (from, to) => {
    const answer = run(from) as Answered;
    expect(answer.statusCode).toBe(301);
    expect(answer.headers.location!.value).toBe(to);
  });

  it("keeps the query string across the redirect", () => {
    const answer = run("/sites/blog/about", {
      q: { value: "cats" },
      tag: { value: "a", multiValue: [{ value: "a" }, { value: "b" }] },
      flag: { value: "" },
    }) as Answered;
    expect(answer.headers.location!.value).toBe("/sites/blog/about/?q=cats&tag=a&tag=b&flag");
  });

  it("answers 404 for an address that names no site", () => {
    expect(run("/sites/")).toMatchObject({ statusCode: 404 });
    expect(run("/sites/Bad_Id/")).toMatchObject({ statusCode: 404 });
  });

  it("never reaches outside the site's folder", () => {
    // CloudFront normalizes dot segments before the function runs. A key
    // that still holds one is a literal S3 key under _site/, never a path
    // into another prefix.
    expect(run("/sites/blog/..%2F..%2Fx.js")).toMatchObject({
      uri: "/apps/blog/_site/..%2F..%2Fx.js",
    });
  });
});

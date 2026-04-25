import webAssets from "./web-assets.json";

type Asset = { content: string; isBase64: boolean; contentType: string };
const assets = webAssets as Record<string, Asset>;

function resolve(urlPath: string): Asset | null {
  // Exact match
  if (assets[urlPath]) return assets[urlPath];
  // /path/ → /path/index.html
  if (assets[urlPath.replace(/\/$/, "") + "/index.html"]) return assets[urlPath.replace(/\/$/, "") + "/index.html"];
  // /path → /path.html
  if (assets[urlPath + ".html"]) return assets[urlPath + ".html"];
  // SPA fallback
  return assets["/index.html"] ?? null;
}

export const handler = async (event: { rawPath?: string; rawQueryString?: string }) => {
  const urlPath = event.rawPath ?? "/";
  const asset = resolve(urlPath);

  if (!asset) {
    return { statusCode: 404, headers: { "Content-Type": "text/plain" }, body: "Not Found", isBase64Encoded: false };
  }

  const isImmutable = urlPath.startsWith("/_next/static/");

  return {
    statusCode: 200,
    headers: {
      "Content-Type": asset.contentType,
      "Cache-Control": isImmutable ? "public, max-age=31536000, immutable" : "public, max-age=0, must-revalidate",
    },
    body: asset.content,
    isBase64Encoded: asset.isBase64,
  };
};

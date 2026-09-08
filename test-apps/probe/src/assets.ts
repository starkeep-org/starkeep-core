/**
 * Probe's one static asset: the shell's script, and the name it is served under.
 *
 * Lives in its own module because it is needed in three places — the local
 * server answers it from `handleRequest`, the cloud bundle stages it to disk
 * for the platform's web adapter to serve, and both must be byte-identical.
 * A fixture whose two surfaces disagree is testing itself rather than the
 * platform.
 */

/**
 * A content-hashed asset path, so the platform's `/apps/*\/_next/static/*`
 * CloudFront behavior has something immutable to cache. The `_next/static`
 * spelling is the platform's cache-behavior convention rather than a Next.js
 * artifact — Probe uses no framework at all.
 */
export const ASSET_NAME = "probe.5f3a9c21.js";

/**
 * The shell's script, served as the immutable asset.
 *
 * Uploading is the one flow that differs by surface, and the difference is not
 * cosmetic. In the cloud the presigned URL points at S3 and the browser PUTs to
 * it directly — which is the only place anything exercises S3's CORS
 * configuration on a real presigned PUT. Locally the presign endpoint hands
 * back a loopback URL on the data server's own origin, which a page served from
 * the app's origin cannot PUT to, so the upload goes through the app's own
 * server instead. Both paths end in the same `POST /data/records`.
 */
export function assetScript(): string {
  return `(() => {
const { base, cloud } = window.__PROBE__;
const api = base + "/api/local-data";
const statusEl = document.getElementById("status");
const grid = document.getElementById("grid");

async function sha256Hex(buf) {
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function render() {
  const res = await fetch(api + "/data/records?limit=200&include=metadata");
  if (!res.ok) { statusEl.textContent = "Data server GET /data/records → " + res.status; return; }
  const { records } = await res.json();
  grid.replaceChildren();
  for (const r of records) {
    if (!r.original_filename) continue;
    const img = document.createElement("img");
    img.alt = r.original_filename;
    img.width = 64;
    const u = await fetch(api + "/data/records/" + r.id + "/file-url");
    if (u.ok) img.src = (await u.json()).url;
    grid.appendChild(img);
  }
}

async function upload(file) {
  const buf = await file.arrayBuffer();
  const contentHash = await sha256Hex(buf);
  const type = file.type === "image/jpeg" ? "image/jpeg" : "image/png";
  const key = "shared/image/" + contentHash.slice(0, 2) + "/" + contentHash;

  if (cloud) {
    const p = await fetch(api + "/files/presign", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key, contentType: type, intent: "instant" }),
    });
    if (!p.ok) { statusEl.textContent = "presign → " + p.status; return; }
    const presign = await p.json();
    const headers = { "Content-Type": type };
    // Mandatory when present: they are inside the signature, so dropping one
    // fails the PUT rather than storing something unverified.
    if (presign.checksumSha256) headers["x-amz-checksum-sha256"] = presign.checksumSha256;
    if (presign.storageClass) headers["x-amz-storage-class"] = presign.storageClass;
    if (presign.tagging && Object.keys(presign.tagging).length) {
      headers["x-amz-tagging"] = Object.entries(presign.tagging)
        .map(([k, v]) => encodeURIComponent(k) + "=" + encodeURIComponent(v)).join("&");
    }
    const put = await fetch(presign.url, { method: "PUT", headers, body: buf });
    if (!put.ok) { statusEl.textContent = "S3 PUT → " + put.status; return; }
  } else {
    const up = await fetch(base + "/api/upload?type=" + encodeURIComponent(type), {
      method: "PUT", headers: { "Content-Type": type }, body: buf,
    });
    if (!up.ok) { statusEl.textContent = "upload → " + up.status; return; }
  }

  const reg = await fetch(api + "/data/records", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type, contentType: type, contentHash, sizeBytes: buf.byteLength, fileName: file.name,
    }),
  });
  if (!reg.ok) { statusEl.textContent = "register → " + reg.status; return; }
  const body = await reg.json();
  statusEl.textContent = body.deduped
    ? file.name + " is already in your library"
    : "Uploaded " + file.name;
  await render();
}

document.getElementById("file").addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (file) upload(file);
});
render();
})();`;
}

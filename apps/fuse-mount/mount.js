/**
 * Starkeep FUSE mount — exposes records as files via FUSE-T.
 *
 * Directory layout:
 *   ~/StarkeepFS/
 *     media:photo/
 *       Test Photo.png          (record with file)
 *     note/
 *       Test Note.json          (record payload as JSON)
 *
 * Reads file content from the data server (local cache → S3 presigned URL).
 * Supports writing — drop files into type directories to create records.
 */

import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const Fuse = require("fuse-native");

import { mkdirSync, watch, readFileSync, unlinkSync, readdirSync } from "node:fs";
import { join, extname, basename } from "node:path";
import { homedir } from "node:os";

const DATA_SERVER = process.env.STARKEEP_DATA_SERVER_URL || "http://127.0.0.1:9820";
const MOUNT_POINT = process.env.STARKEEP_MOUNT_POINT || join(homedir(), "StarkeepFS");
const INBOX_DIR = process.env.STARKEEP_INBOX || join(homedir(), "StarkeepFS-Inbox");

// ---------------------------------------------------------------------------
// Data server client
// ---------------------------------------------------------------------------

async function fetchJson(path) {
  const res = await fetch(`${DATA_SERVER}${path}`);
  if (!res.ok) return null;
  return res.json();
}

async function postJson(path, body) {
  const res = await fetch(`${DATA_SERVER}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) return null;
  return res.json();
}

// Cache with TTL to avoid hammering the data server on every getattr/readdir
const cache = new Map();
const CACHE_TTL_MS = 5_000;

function cached(key, fetcher) {
  const entry = cache.get(key);
  if (entry && Date.now() - entry.ts < CACHE_TTL_MS) return entry.promise;
  const promise = fetcher();
  cache.set(key, { promise, ts: Date.now() });
  return promise;
}

function invalidateCache(prefix) {
  for (const key of cache.keys()) {
    if (key.startsWith(prefix) || key === "types") cache.delete(key);
  }
}

function getTypes() {
  return cached("types", () => fetchJson("/data/types"));
}

function getRecords(type) {
  return cached(`records:${type}`, () => fetchJson(`/data/records?type=${encodeURIComponent(type)}&limit=1000`));
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

async function resolve(path) {
  if (path === "/") return { kind: "root" };

  const parts = path.split("/").filter(Boolean);

  if (parts.length === 1) {
    const typesData = await getTypes();
    if (!typesData) return null;
    const match = typesData.types.find((t) => t.record_type === parts[0]);
    if (match) return { kind: "type_dir", type: parts[0], latestUpdated: match.latest_updated };
    return null;
  }

  if (parts.length === 2) {
    const type = parts[0];
    const filename = parts[1];

    // Check in-flight writes first
    const writeKey = `/${type}/${filename}`;
    if (pendingWrites.has(writeKey)) return { kind: "pending_file", type, filename };

    const recordsData = await getRecords(type);
    if (!recordsData) return null;
    const record = recordsData.records.find((r) => recordFilename(r) === filename);
    if (record) return { kind: "file", type, record };
    return null;
  }

  return null;
}

function recordFilename(record) {
  const title = record.payload?.title || record.payload?.name || record.id;
  const ext = extensionForRecord(record);
  const safe = String(title).replace(/[/\0]/g, "_");
  return `${safe}${ext}`;
}

function extensionForRecord(record) {
  if (record.mime_type) {
    const map = {
      "image/png": ".png",
      "image/jpeg": ".jpg",
      "image/gif": ".gif",
      "image/webp": ".webp",
      "application/pdf": ".pdf",
      "text/plain": ".txt",
      "text/markdown": ".md",
      "application/json": ".json",
    };
    if (map[record.mime_type]) return map[record.mime_type];
  }
  if (!record.object_storage_key) return ".json";
  return "";
}

const EXT_TO_MIME = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".json": "application/json",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".heic": "image/heic",
};

function mimeFromFilename(filename) {
  const ext = extname(filename).toLowerCase();
  return EXT_TO_MIME[ext] || "application/octet-stream";
}

// ---------------------------------------------------------------------------
// File content fetching
// ---------------------------------------------------------------------------

const fileContentCache = new Map();
const FILE_CACHE_TTL_MS = 30_000;

async function getFileContent(record) {
  const id = record.id;
  const entry = fileContentCache.get(id);
  if (entry && Date.now() - entry.ts < FILE_CACHE_TTL_MS) return entry.data;

  let data;
  if (record.object_storage_key) {
    const urlData = await fetchJson(`/data/records/${id}/file-url`);
    if (urlData?.url) {
      const res = await fetch(urlData.url);
      if (res.ok) {
        data = Buffer.from(await res.arrayBuffer());
      }
    }
  }

  if (!data) {
    data = Buffer.from(JSON.stringify(record.payload || {}, null, 2));
  }

  fileContentCache.set(id, { data, ts: Date.now() });
  return data;
}

// ---------------------------------------------------------------------------
// Write support — buffer writes in memory, upload on release
// ---------------------------------------------------------------------------

// Map<path, { type, filename, chunks: Buffer[], size: number, xattrs: Map }>
const pendingWrites = new Map();

async function uploadPendingFile(path) {
  const pending = pendingWrites.get(path);
  if (!pending) return;
  pendingWrites.delete(path);

  // Don't upload Apple Double metadata files
  if (pending.isAppleDouble) return;

  const fileBuffer = Buffer.concat(pending.chunks, pending.size);
  if (fileBuffer.length === 0) return; // skip empty files

  const contentType = mimeFromFilename(pending.filename);
  const title = basename(pending.filename, extname(pending.filename));

  try {
    const result = await postJson("/data/records", {
      type: pending.type,
      payload: { title },
      fileName: pending.filename,
      contentType,
      fileBase64: fileBuffer.toString("base64"),
    });
    if (!result) {
      console.error(`Upload failed for ${pending.filename}: data server returned error`);
      return;
    }
    // Invalidate caches so the new file shows up
    invalidateCache(`records:${pending.type}`);
    fileContentCache.clear();
    console.log(`Uploaded: ${pending.filename} → ${pending.type} (${result.record?.id})`);
  } catch (e) {
    console.error(`Upload failed for ${pending.filename}:`, e);
  }
}

// ---------------------------------------------------------------------------
// FUSE operations
// ---------------------------------------------------------------------------

function stat(mode, size, time) {
  const t = time ? new Date(time) : new Date();
  return {
    mtime: t,
    atime: t,
    ctime: t,
    nlink: 1,
    size: size || 0,
    mode,
    uid: process.getuid(),
    gid: process.getgid(),
  };
}

const DIR_MODE = 0o40755;
const FILE_MODE_RO = 0o100444;
const FILE_MODE_RW = 0o100644;

const ops = {
  readdir(path, cb) {
    (async () => {
      try {
        if (path === "/") {
          const typesData = await getTypes();
          if (!typesData) return cb(0, []);
          return cb(0, typesData.types.map((t) => t.record_type));
        }

        const parts = path.split("/").filter(Boolean);
        if (parts.length === 1) {
          const recordsData = await getRecords(parts[0]);
          if (!recordsData) return cb(0, []);
          return cb(0, recordsData.records.map(recordFilename));
        }

        cb(0, []);
      } catch (e) {
        console.error("readdir error:", e);
        cb(Fuse.EIO);
      }
    })();
  },

  getattr(path, cb) {
    (async () => {
      try {
        // Check pending writes first
        if (pendingWrites.has(path)) {
          const p = pendingWrites.get(path);
          return cb(0, stat(FILE_MODE_RW, p.size));
        }

        const resolved = await resolve(path);
        if (!resolved) return cb(Fuse.ENOENT);

        if (resolved.kind === "root" || resolved.kind === "type_dir") {
          return cb(0, stat(DIR_MODE, 4096, resolved.kind === "type_dir" ? resolved.latestUpdated : undefined));
        }

        if (resolved.kind === "pending_file") {
          const p = pendingWrites.get(`/${resolved.type}/${resolved.filename}`);
          return cb(0, stat(FILE_MODE_RW, p ? p.size : 0));
        }

        if (resolved.kind === "file") {
          const r = resolved.record;
          let size = r.size_bytes;
          if (!size) {
            const content = await getFileContent(r);
            size = content.length;
          }
          return cb(0, stat(FILE_MODE_RO, size, r.updated_at));
        }

        cb(Fuse.ENOENT);
      } catch (e) {
        console.error("getattr error:", e);
        cb(Fuse.EIO);
      }
    })();
  },

  // Create a new file — starts a pending write
  create(path, mode, cb) {
    const parts = path.split("/").filter(Boolean);
    if (parts.length !== 2) return cb(Fuse.EPERM);

    const type = parts[0];
    const filename = parts[1];

    // Skip .DS_Store but allow ._ (Apple Double) files — cp/Finder need them
    if (filename === ".DS_Store") return cb(Fuse.EPERM);

    const isAppleDouble = filename.startsWith("._");
    console.log(`create: ${path}${isAppleDouble ? " (apple double)" : ""}`);
    pendingWrites.set(path, { type, filename, chunks: [], size: 0, xattrs: new Map(), isAppleDouble });
    cb(0, 0);
  },

  open(path, flags, cb) {
    cb(0, 0);
  },

  read(path, fd, buf, len, pos, cb) {
    (async () => {
      try {
        // Read from pending write buffer
        if (pendingWrites.has(path)) {
          const p = pendingWrites.get(path);
          const content = Buffer.concat(p.chunks, p.size);
          if (pos >= content.length) return cb(0);
          const slice = content.slice(pos, pos + len);
          slice.copy(buf);
          return cb(slice.length);
        }

        const resolved = await resolve(path);
        if (!resolved || resolved.kind !== "file") return cb(Fuse.ENOENT);

        const content = await getFileContent(resolved.record);
        if (pos >= content.length) return cb(0);

        const slice = content.slice(pos, pos + len);
        slice.copy(buf);
        cb(slice.length);
      } catch (e) {
        console.error("read error:", e);
        cb(Fuse.EIO);
      }
    })();
  },

  write(path, fd, buf, len, pos, cb) {
    const pending = pendingWrites.get(path);
    if (!pending) return cb(Fuse.EPERM);

    const data = buf.slice(0, len);
    console.log(`write: ${path} pos=${pos} len=${len} pending_size=${pending.size}`);

    // Handle sparse/sequential writes — expand chunks to cover position
    const current = Buffer.concat(pending.chunks, pending.size);
    const needed = pos + len;
    let updated;
    if (pos <= current.length) {
      updated = Buffer.alloc(Math.max(current.length, needed));
      current.copy(updated);
    } else {
      updated = Buffer.alloc(needed);
      current.copy(updated);
    }
    data.copy(updated, pos);

    pending.chunks = [updated];
    pending.size = updated.length;

    cb(len);
  },

  truncate(path, size, cb) {
    const pending = pendingWrites.get(path);
    if (pending) {
      if (size === 0) {
        pending.chunks = [];
        pending.size = 0;
      } else {
        const current = Buffer.concat(pending.chunks, pending.size);
        const truncated = current.slice(0, size);
        pending.chunks = [truncated];
        pending.size = truncated.length;
      }
    }
    cb(0);
  },

  release(path, fd, cb) {
    (async () => {
      try {
        if (pendingWrites.has(path)) {
          const p = pendingWrites.get(path);
          console.log(`release: ${path} size=${p.size}`);
          await uploadPendingFile(path);
        }
        cb(0);
      } catch (e) {
        console.error("release error:", e);
        cb(0);
      }
    })();
  },

  unlink(path, cb) {
    // Allow deleting pending/transient files
    if (pendingWrites.has(path)) {
      pendingWrites.delete(path);
    }
    cb(0);
  },

  rename(src, dest, cb) {
    // Support rename for tools like rsync that write to .tmp then rename
    if (pendingWrites.has(src)) {
      const pending = pendingWrites.get(src);
      const parts = dest.split("/").filter(Boolean);
      if (parts.length === 2) {
        pending.filename = parts[1];
        pending.type = parts[0];
      }
      pendingWrites.delete(src);
      pendingWrites.set(dest, pending);
    }
    cb(0);
  },

  utimens(path, atime, mtime, cb) {
    cb(0);
  },

  chmod(path, mode, cb) {
    cb(0);
  },

  chown(path, uid, gid, cb) {
    cb(0);
  },

  setxattr(path, name, buffer, length, offset, flags, cb) {
    const pending = pendingWrites.get(path);
    if (pending) {
      pending.xattrs.set(name, Buffer.from(buffer.slice(0, length)));
    }
    cb(0);
  },

  getxattr(path, name, buffer, length, offset, cb) {
    const pending = pendingWrites.get(path);
    if (pending) {
      const val = pending.xattrs.get(name);
      if (val) {
        if (length === 0) return cb(val.length);
        val.copy(buffer);
        return cb(val.length);
      }
    }
    cb(Fuse.ENODATA);
  },

  listxattr(path, buffer, length, cb) {
    const pending = pendingWrites.get(path);
    if (pending && pending.xattrs.size > 0) {
      const names = [...pending.xattrs.keys()].join("\0") + "\0";
      if (length === 0) return cb(Buffer.byteLength(names));
      buffer.write(names);
      return cb(Buffer.byteLength(names));
    }
    cb(0, 0);
  },

  statfs(path, cb) {
    cb(0, {
      bsize: 4096,
      frsize: 4096,
      blocks: 1000000,
      bfree: 500000,
      bavail: 500000,
      files: 1000000,
      ffree: 500000,
      favail: 500000,
      fsid: 0,
      flag: 0,
      namemax: 255,
    });
  },
};

// ---------------------------------------------------------------------------
// Mount
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Inbox — a regular directory where files can be dropped via Finder/cp.
// Subdirectories map to record types. Files are uploaded then removed.
// ---------------------------------------------------------------------------

mkdirSync(INBOX_DIR, { recursive: true });

async function processInboxFile(type, filename, filepath) {
  if (filename.startsWith(".") || filename === ".DS_Store") return;
  try {
    const data = readFileSync(filepath);
    if (data.length === 0) return;
    const contentType = mimeFromFilename(filename);
    const title = basename(filename, extname(filename));
    const result = await postJson("/data/records", {
      type,
      payload: { title },
      fileName: filename,
      contentType,
      fileBase64: data.toString("base64"),
    });
    if (result) {
      unlinkSync(filepath);
      invalidateCache(`records:${type}`);
      fileContentCache.clear();
      console.log(`Inbox: ${filename} → ${type} (${result.record?.id})`);
    }
  } catch (e) {
    // File might still be writing — will retry on next event
    if (e.code !== "ENOENT" && e.code !== "EBUSY") {
      console.error(`Inbox error for ${filename}:`, e.message);
    }
  }
}

function setupInbox() {
  // Create a subdirectory per known type, plus common defaults
  const defaultTypes = ["media:photo", "media:video", "note", "document"];
  for (const type of defaultTypes) {
    mkdirSync(join(INBOX_DIR, type), { recursive: true });
  }

  // Also create dirs for types that already exist in Starkeep
  getTypes().then((data) => {
    if (data?.types) {
      for (const t of data.types) {
        mkdirSync(join(INBOX_DIR, t.record_type), { recursive: true });
      }
    }
  });

  // Watch each subdirectory
  const watched = new Set();
  function watchType(type) {
    if (watched.has(type)) return;
    watched.add(type);
    const dir = join(INBOX_DIR, type);
    mkdirSync(dir, { recursive: true });

    // Process existing files on startup
    for (const f of readdirSync(dir)) {
      processInboxFile(type, f, join(dir, f));
    }

    watch(dir, { persistent: false }, (event, filename) => {
      if (!filename || filename.startsWith(".")) return;
      // Debounce: wait for file to finish writing
      setTimeout(() => processInboxFile(type, filename, join(dir, filename)), 500);
    });
    console.log(`Inbox watching: ${dir}`);
  }

  // Watch the inbox root for new type directories
  watch(INBOX_DIR, { persistent: false }, (event, filename) => {
    if (filename && !filename.startsWith(".")) {
      watchType(filename);
    }
  });

  // Watch known types
  for (const type of defaultTypes) watchType(type);
  getTypes().then((data) => {
    if (data?.types) {
      for (const t of data.types) watchType(t.record_type);
    }
  });
}

setupInbox();

mkdirSync(MOUNT_POINT, { recursive: true });

const fuse = new Fuse(MOUNT_POINT, ops, {
  debug: false,
  force: true,
  mkdir: true,
});

fuse.mount((err) => {
  if (err) {
    console.error("Mount failed:", err);
    process.exit(1);
  }
  console.log(`Starkeep mounted at ${MOUNT_POINT}`);
  console.log(`Inbox at ${INBOX_DIR} (drag files here)`);
  console.log(`Data server: ${DATA_SERVER}`);
  console.log("Press Ctrl+C to unmount.");
});

const cleanup = () => {
  fuse.unmount((err) => {
    if (err) console.error("Unmount error:", err);
    else console.log("Unmounted.");
    process.exit(err ? 1 : 0);
  });
};

process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);

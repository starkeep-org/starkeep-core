/**
 * An in-memory expo-file-system, implementing the module's *shape*.
 *
 * Shared between the storage adapter's own tests and the node assembly's, so
 * both exercise the same fake — a second copy would be a second thing that can
 * drift from what expo-file-system actually does.
 *
 * `openHandles` is tracked because a leaked file handle is a real failure on a
 * phone, where the open-file limit is low enough to matter within one session.
 */
import type {
  ExpoDirectory,
  ExpoFile,
  ExpoFileHandle,
  ExpoFileSystem,
} from "../../src/storage/expo-object-storage";

/** In-memory expo-file-system. Tracks handle lifetime, which is a real leak risk. */
export function fakeExpoFs() {
  const files = new Map<string, Uint8Array>();
  const dirs = new Set<string>();
  const state = { openHandles: 0, rangedReads: [] as Array<{ offset: number; length: number }> };

  const file = (path: string): ExpoFile => ({
    get exists() {
      return files.has(path);
    },
    get size() {
      return files.get(path)?.byteLength ?? null;
    },
    get uri() {
      return path;
    },
    readableStream() {
      const bytes = files.get(path);
      if (!bytes) throw new Error(`no such file: ${path}`);
      // Chunked, so a consumer that assumes one chunk fails here rather than on
      // a device.
      let at = 0;
      return new ReadableStream<Uint8Array>({
        pull(controller) {
          if (at >= bytes.byteLength) {
            controller.close();
            return;
          }
          const end = Math.min(at + 8, bytes.byteLength);
          controller.enqueue(bytes.subarray(at, end));
          at = end;
        },
      });
    },
    writableStream() {
      const chunks: Uint8Array[] = [];
      return new WritableStream<Uint8Array>({
        write(chunk) {
          chunks.push(chunk);
        },
        close() {
          const out = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
          let at = 0;
          for (const c of chunks) {
            out.set(c, at);
            at += c.byteLength;
          }
          files.set(path, out);
        },
      });
    },
    open(): ExpoFileHandle {
      const bytes = files.get(path) ?? new Uint8Array();
      state.openHandles += 1;
      const handle: ExpoFileHandle = {
        offset: 0,
        readBytes(length: number) {
          state.rangedReads.push({ offset: handle.offset, length });
          const slice = bytes.subarray(handle.offset, handle.offset + length);
          handle.offset += slice.byteLength;
          return slice;
        },
        close() {
          state.openHandles -= 1;
        },
      };
      return handle;
    },
    create() {
      if (!files.has(path)) files.set(path, new Uint8Array());
    },
    delete() {
      files.delete(path);
    },
    async text() {
      return new TextDecoder().decode(files.get(path) ?? new Uint8Array());
    },
    write(contents: string | Uint8Array) {
      files.set(path, typeof contents === "string" ? new TextEncoder().encode(contents) : contents);
    },
  });

  const directory = (path: string): ExpoDirectory => ({
    get exists() {
      return dirs.has(path);
    },
    get uri() {
      return path;
    },
    create() {
      dirs.add(path);
    },
    list() {
      return [];
    },
  });

  const fs: ExpoFileSystem = { file, directory };
  return { fs, files, state };
}

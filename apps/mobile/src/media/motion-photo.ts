/**
 * Finding the video inside an Android Motion Photo (item 16).
 *
 * ## Why this is needed on Android and not on iOS
 *
 * A Live Photo on iOS is genuinely two files, and `PHAsset.mediaSubtypes` says
 * which — which is why item 31 could pair them at import by looking at siblings
 * on disk. Android does the opposite: it appends the video **inside the JPEG**,
 * after the image data, and describes where it is in XMP. There are no siblings
 * to pair, so nothing about item 31 helps, and a Motion Photo imported without
 * this is a still that silently lost its motion.
 *
 * This has to happen at *capture* on Android, which is why the plan puts it in
 * this phase rather than with the import work.
 *
 * ## Two formats, and the trap in the first one
 *
 * **v1 (`GCamera:MicroVideoOffset`)** — the value is a length measured back from
 * the **end of the file**, not an offset from the start. Reading it as a
 * forward offset lands somewhere inside the JPEG's own pixel data, which
 * frequently still contains a plausible-looking `ftyp` and produces a video
 * file that no player will open. It fails late and confusingly, which is why it
 * gets a named helper and a test of its own.
 *
 * **v2 (`Container:Directory`)** — a list of items with MIME types and lengths.
 * The primary item (the JPEG) has no meaningful length; every subsequent item is
 * laid out end-to-end at the tail of the file. So the video's start is the file
 * length minus the sum of every trailing item's length and padding, which is
 * *not* the same as "minus the video's own length" whenever more than one item
 * follows the primary — Ultra HDR files carry a gain map there.
 */

/** What a Motion Photo's XMP says about its embedded video. */
export interface MotionPhotoVideo {
  /** Byte offset into the file where the video container starts. */
  readonly offset: number;
  readonly length: number;
  readonly mimeType: string;
  /** Which XMP dialect described it — useful when a file is reported broken. */
  readonly via: "micro-video-offset" | "container-directory";
  /**
   * Where the still sits within the video, in microseconds, when stated.
   *
   * This is the frame the camera chose as *the photo*, so a viewer that scrubs
   * should start here rather than at zero.
   */
  readonly presentationTimestampUs?: number;
}

/** One entry of a v2 `Container:Directory`. */
interface ContainerItem {
  mime: string;
  semantic: string;
  length: number;
  padding: number;
}

const XMP_SCAN_LIMIT = 512 * 1024;

/**
 * Pull the XMP packet out of a JPEG.
 *
 * Scans for the packet delimiters rather than walking APP1 segments. That is the
 * cheaper and more forgiving choice here: Motion Photo XMP is routinely
 * *extended* XMP split across multiple APP1 segments, and a strict segment
 * walker has to reassemble those correctly or find nothing at all — whereas the
 * fields this needs are small and live in the main packet.
 *
 * Bounded because a Motion Photo's tail is a whole video, and scanning it for
 * text that is only ever near the front would mean reading tens of megabytes to
 * find nothing.
 */
export function extractXmp(bytes: Uint8Array): string | null {
  const limit = Math.min(bytes.byteLength, XMP_SCAN_LIMIT);
  const head = new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(0, limit));
  const start = head.indexOf("<x:xmpmeta");
  if (start < 0) return null;
  const end = head.indexOf("</x:xmpmeta>", start);
  if (end < 0) return null;
  return head.slice(start, end + "</x:xmpmeta>".length);
}

/**
 * Read an XMP attribute, in either of the two spellings XMP allows.
 *
 * A property can appear as an attribute (`GCamera:MicroVideoOffset="123"`) or as
 * an element (`<GCamera:MicroVideoOffset>123</GCamera:MicroVideoOffset>`), and
 * which one a camera writes is not something the reader gets to choose. Handling
 * only the attribute form works on most files and mysteriously fails on some.
 */
export function readXmpValue(xmp: string, property: string): string | null {
  const attribute = new RegExp(`${property}\\s*=\\s*"([^"]*)"`).exec(xmp);
  if (attribute) return attribute[1]!;
  const element = new RegExp(`<${property}[^>]*>([^<]*)</${property}>`).exec(xmp);
  return element ? element[1]!.trim() : null;
}

/**
 * v1: the offset is a length back from the end of the file.
 *
 * Separated and exported so the direction is testable on its own. Getting it
 * backwards produces a plausible-looking file that no player opens, and the
 * failure surfaces far from the cause.
 */
export function offsetFromTail(fileLength: number, trailingLength: number): number {
  return fileLength - trailingLength;
}

function parseContainerItems(xmp: string): ContainerItem[] {
  const items: ContainerItem[] = [];
  // Items appear as rdf:li elements, each carrying Item: attributes. Matched
  // individually rather than by parsing the whole RDF tree, because the tree is
  // not needed and an XML parser is a dependency this does not warrant.
  const pattern = /<rdf:li\b[^>]*?\/>|<rdf:li\b[^>]*?>[\s\S]*?<\/rdf:li>/g;
  for (const match of xmp.match(pattern) ?? []) {
    const mime = readXmpValue(match, "Item:Mime");
    if (!mime) continue;
    items.push({
      mime,
      semantic: readXmpValue(match, "Item:Semantic") ?? "",
      length: Number(readXmpValue(match, "Item:Length") ?? 0) || 0,
      padding: Number(readXmpValue(match, "Item:Padding") ?? 0) || 0,
    });
  }
  return items;
}

/**
 * Locate the embedded video, or `null` when there is none.
 *
 * `null` is the ordinary answer: most JPEGs are not Motion Photos, and treating
 * their absence as an error would make every normal photo look broken.
 */
export function findMotionPhotoVideo(bytes: Uint8Array): MotionPhotoVideo | null {
  const xmp = extractXmp(bytes);
  if (!xmp) return null;

  const timestamp = Number(
    readXmpValue(xmp, "GCamera:MicroVideoPresentationTimestampUs") ??
      readXmpValue(xmp, "Container:PresentationTimestampUs") ??
      NaN,
  );
  const presentation = Number.isFinite(timestamp) ? { presentationTimestampUs: timestamp } : {};

  // v2 first: a file carrying both describes itself more precisely here, and
  // the directory accounts for trailing items the v1 field cannot see.
  const items = parseContainerItems(xmp);
  if (items.length > 1) {
    // Everything after the primary item sits end-to-end at the tail. Summing
    // them is what makes this correct for an Ultra HDR file, whose gain map
    // sits between the JPEG and the video — subtracting only the video's length
    // would start the read inside the gain map.
    const trailing = items.slice(1);
    const totalTrailing = trailing.reduce((sum, i) => sum + i.length + i.padding, 0);
    let cursor = offsetFromTail(bytes.byteLength, totalTrailing);
    for (const item of trailing) {
      if (item.mime.startsWith("video/")) {
        return {
          offset: cursor,
          length: item.length,
          mimeType: item.mime,
          via: "container-directory",
          ...presentation,
        };
      }
      cursor += item.length + item.padding;
    }
    return null;
  }

  const micro = readXmpValue(xmp, "GCamera:MicroVideoOffset");
  if (micro !== null) {
    const length = Number(micro);
    if (!Number.isFinite(length) || length <= 0 || length > bytes.byteLength) return null;
    return {
      // The trap: this value is a length back from the end, not a forward
      // offset. See offsetFromTail.
      offset: offsetFromTail(bytes.byteLength, length),
      length,
      // v1 has no MIME field; the format is always MP4 in practice.
      mimeType: "video/mp4",
      via: "micro-video-offset",
      ...presentation,
    };
  }

  return null;
}

/** The four-byte box type at the head of an ISO-BMFF container. */
function looksLikeIsoBmff(bytes: Uint8Array, at: number): boolean {
  if (at < 0 || at + 12 > bytes.byteLength) return false;
  // Byte 4..8 is the box type; `ftyp` is the first box of an MP4.
  return (
    bytes[at + 4] === 0x66 && // f
    bytes[at + 5] === 0x74 && // t
    bytes[at + 6] === 0x79 && // y
    bytes[at + 7] === 0x70 //  p
  );
}

/**
 * The embedded video's bytes, or `null`.
 *
 * Validated to begin with an `ftyp` box rather than returned on the strength of
 * the offset alone. XMP is written by cameras and is wrong often enough to
 * matter, and an offset that is plausible but wrong yields bytes that fail much
 * later, inside a decoder, with a message about the wrong thing.
 */
export function extractMotionPhotoVideo(bytes: Uint8Array): Uint8Array | null {
  const found = findMotionPhotoVideo(bytes);
  if (!found) return null;
  if (found.offset < 0 || found.offset + found.length > bytes.byteLength) return null;
  if (!looksLikeIsoBmff(bytes, found.offset)) return null;
  return bytes.subarray(found.offset, found.offset + found.length);
}

/** Whether this JPEG carries motion at all — cheap enough to ask per file. */
export function isMotionPhoto(bytes: Uint8Array): boolean {
  return findMotionPhotoVideo(bytes) !== null;
}

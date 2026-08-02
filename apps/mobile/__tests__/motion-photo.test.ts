/**
 * Motion Photo extraction (item 16).
 *
 * Files are built here byte by byte, because the thing under test is an offset
 * calculation and a hand-built file is the only way to know exactly where the
 * video really starts. Against a real Pixel file the arithmetic would be
 * invisible — it would either work or produce a broken video, with no way to see
 * which byte was wrong.
 *
 * That leaves verification against real camera output as an open gap, which is
 * recorded. The DNG work earlier in this project is the argument for taking
 * that seriously: every synthetic fixture agreed with a bug that a single real
 * file exposed immediately.
 */
import { describe, it, expect } from "vitest";
import {
  findMotionPhotoVideo,
  extractMotionPhotoVideo,
  extractXmp,
  readXmpValue,
  offsetFromTail,
  isMotionPhoto,
} from "../src/media/motion-photo";

const encoder = new TextEncoder();

/** A minimal MP4: an `ftyp` box, which is what the validator looks for. */
function fakeMp4(size: number): Uint8Array {
  const out = new Uint8Array(size);
  out.set([0x00, 0x00, 0x00, 0x18], 0); // box size
  out.set(encoder.encode("ftyp"), 4);
  out.set(encoder.encode("mp42"), 8);
  // Distinct tail byte, so "did we get *this* buffer" is answerable.
  out[size - 1] = 0xab;
  return out;
}

/** JPEG head + XMP packet + optional trailing segments. */
function buildJpeg(xmpBody: string, trailers: Uint8Array[] = []): Uint8Array {
  const xmp = `<x:xmpmeta xmlns:x="adobe:ns:meta/">${xmpBody}</x:xmpmeta>`;
  const head = new Uint8Array(2 + xmp.length + 64);
  head.set([0xff, 0xd8], 0); // SOI
  head.set(encoder.encode(xmp), 2);
  const total = head.byteLength + trailers.reduce((n, t) => n + t.byteLength, 0);
  const out = new Uint8Array(total);
  out.set(head, 0);
  let at = head.byteLength;
  for (const t of trailers) {
    out.set(t, at);
    at += t.byteLength;
  }
  return out;
}

describe("reading XMP", () => {
  it("finds the packet in a JPEG", () => {
    const jpeg = buildJpeg(`<rdf:RDF GCamera:MicroVideo="1"/>`);
    expect(extractXmp(jpeg)).toContain("MicroVideo");
  });

  it("reports nothing for a JPEG with no XMP", () => {
    expect(extractXmp(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]))).toBeNull();
  });

  // A property can appear either way and which one a camera writes is not the
  // reader's choice. Handling only attributes works on most files and
  // mysteriously fails on some.
  it("reads a property written as an attribute or as an element", () => {
    expect(readXmpValue(`GCamera:MicroVideoOffset="4096"`, "GCamera:MicroVideoOffset")).toBe("4096");
    expect(
      readXmpValue(
        `<GCamera:MicroVideoOffset>4096</GCamera:MicroVideoOffset>`,
        "GCamera:MicroVideoOffset",
      ),
    ).toBe("4096");
  });

  it("reports null for a property that is not there", () => {
    expect(readXmpValue(`<x/>`, "GCamera:MicroVideoOffset")).toBeNull();
  });
});

describe("the offset direction", () => {
  // The trap, isolated. MicroVideoOffset is a length back from the END of the
  // file. Read as a forward offset it lands inside the JPEG's pixel data, which
  // frequently still contains a plausible-looking box header — so it produces a
  // file that no player opens, failing far from the cause.
  it("measures back from the end of the file", () => {
    expect(offsetFromTail(1000, 400)).toBe(600);
  });
});

describe("v1 — GCamera:MicroVideoOffset", () => {
  const video = fakeMp4(256);
  const jpeg = buildJpeg(
    `<rdf:RDF GCamera:MicroVideo="1" GCamera:MicroVideoOffset="256" GCamera:MicroVideoPresentationTimestampUs="500000"/>`,
    [video],
  );

  it("locates the video at the tail", () => {
    const found = findMotionPhotoVideo(jpeg)!;
    expect(found.via).toBe("micro-video-offset");
    expect(found.length).toBe(256);
    expect(found.offset).toBe(jpeg.byteLength - 256);
  });

  it("extracts bytes that begin with an ftyp box", () => {
    const extracted = extractMotionPhotoVideo(jpeg)!;
    expect(extracted.byteLength).toBe(256);
    // The distinct tail byte proves it is the video buffer and not merely
    // 256 bytes from a plausible position.
    expect(extracted[extracted.byteLength - 1]).toBe(0xab);
  });

  // v1 has no MIME field and the format is always MP4 in practice.
  it("reports video/mp4", () => {
    expect(findMotionPhotoVideo(jpeg)!.mimeType).toBe("video/mp4");
  });

  // The frame the camera chose as *the photo* — a viewer that scrubs should
  // start here rather than at zero.
  it("carries the presentation timestamp when stated", () => {
    expect(findMotionPhotoVideo(jpeg)!.presentationTimestampUs).toBe(500_000);
  });

  it("rejects an offset longer than the file", () => {
    const bad = buildJpeg(`<rdf:RDF GCamera:MicroVideoOffset="999999"/>`, [fakeMp4(64)]);
    expect(findMotionPhotoVideo(bad)).toBeNull();
  });

  it("rejects a zero or negative offset", () => {
    expect(findMotionPhotoVideo(buildJpeg(`<rdf:RDF GCamera:MicroVideoOffset="0"/>`))).toBeNull();
    expect(findMotionPhotoVideo(buildJpeg(`<rdf:RDF GCamera:MicroVideoOffset="-5"/>`))).toBeNull();
  });
});

describe("v2 — Container:Directory", () => {
  const directory = (items: string) =>
    `<rdf:RDF><Container:Directory><rdf:Seq>${items}</rdf:Seq></Container:Directory></rdf:RDF>`;
  const li = (attrs: string) => `<rdf:li rdf:parseType="Resource"><Container:Item ${attrs}/></rdf:li>`;

  it("locates a video described by the directory", () => {
    const video = fakeMp4(300);
    const jpeg = buildJpeg(
      directory(
        li(`Item:Mime="image/jpeg" Item:Semantic="Primary" Item:Length="0"`) +
          li(`Item:Mime="video/mp4" Item:Semantic="MotionPhoto" Item:Length="300"`),
      ),
      [video],
    );
    const found = findMotionPhotoVideo(jpeg)!;
    expect(found.via).toBe("container-directory");
    expect(found.mimeType).toBe("video/mp4");
    expect(found.offset).toBe(jpeg.byteLength - 300);
  });

  // The case that makes summing necessary. An Ultra HDR file carries a gain map
  // between the JPEG and the video; subtracting only the video's own length
  // would start the read inside the gain map and yield a broken video.
  it("accounts for other trailing items, not just the video", () => {
    const gainMap = new Uint8Array(120).fill(0x11);
    const video = fakeMp4(300);
    const jpeg = buildJpeg(
      directory(
        li(`Item:Mime="image/jpeg" Item:Semantic="Primary" Item:Length="0"`) +
          li(`Item:Mime="image/jpeg" Item:Semantic="GainMap" Item:Length="120"`) +
          li(`Item:Mime="video/mp4" Item:Semantic="MotionPhoto" Item:Length="300"`),
      ),
      [gainMap, video],
    );
    const found = findMotionPhotoVideo(jpeg)!;
    // Not byteLength - 300: the gain map sits between.
    expect(found.offset).toBe(jpeg.byteLength - 300);
    const extracted = extractMotionPhotoVideo(jpeg)!;
    expect(extracted[extracted.byteLength - 1]).toBe(0xab);
  });

  it("honours per-item padding", () => {
    const video = fakeMp4(300);
    const padding = new Uint8Array(16);
    const jpeg = buildJpeg(
      directory(
        li(`Item:Mime="image/jpeg" Item:Semantic="Primary" Item:Length="0"`) +
          li(`Item:Mime="video/mp4" Item:Semantic="MotionPhoto" Item:Length="300" Item:Padding="16"`),
      ),
      [video, padding],
    );
    expect(findMotionPhotoVideo(jpeg)!.offset).toBe(jpeg.byteLength - 316);
  });

  it("reports nothing when the directory has no video item", () => {
    const jpeg = buildJpeg(
      directory(
        li(`Item:Mime="image/jpeg" Item:Semantic="Primary" Item:Length="0"`) +
          li(`Item:Mime="image/jpeg" Item:Semantic="GainMap" Item:Length="120"`),
      ),
      [new Uint8Array(120)],
    );
    expect(findMotionPhotoVideo(jpeg)).toBeNull();
  });
});

describe("guarding against XMP that is simply wrong", () => {
  // XMP is written by cameras and is wrong often enough to matter. An offset
  // that is plausible but wrong yields bytes that fail much later, inside a
  // decoder, with a message about the wrong thing.
  it("refuses bytes that are not an ISO-BMFF container", () => {
    const notVideo = new Uint8Array(256).fill(0x42);
    const jpeg = buildJpeg(`<rdf:RDF GCamera:MicroVideoOffset="256"/>`, [notVideo]);
    // The location is still reported — that is what the XMP says — but the
    // extraction refuses, which is the layer that should.
    expect(findMotionPhotoVideo(jpeg)).not.toBeNull();
    expect(extractMotionPhotoVideo(jpeg)).toBeNull();
  });

  it("refuses a range that runs past the end of the file", () => {
    const jpeg = buildJpeg(`<rdf:RDF GCamera:MicroVideoOffset="100"/>`);
    expect(extractMotionPhotoVideo(jpeg)).toBeNull();
  });
});

describe("ordinary photos", () => {
  // Most JPEGs are not Motion Photos, and treating their absence as an error
  // would make every normal photo look broken.
  it("reports no motion for a plain JPEG", () => {
    expect(isMotionPhoto(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]))).toBe(false);
    expect(extractMotionPhotoVideo(new Uint8Array([0xff, 0xd8]))).toBeNull();
  });

  it("reports no motion for XMP that mentions nothing relevant", () => {
    expect(isMotionPhoto(buildJpeg(`<rdf:RDF dc:creator="someone"/>`))).toBe(false);
  });
});

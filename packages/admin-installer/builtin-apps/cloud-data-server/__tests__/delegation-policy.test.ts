/**
 * The delegation allowlists, one assertion per row of the mode table in
 * plan-headless-delegated-access-2026-11-13.md, Decision 4.
 */
import { describe, expect, it } from "vitest";
import { delegatedMayCall, isDelegatedWrite } from "../src/delegation-policy.js";

const ID = "01J00000000000000000000000";
const KEY = "shared/image/ab/abcdef";

type Row = [label: string, method: string, path: string, read: boolean, readwrite: boolean];

const TABLE: Row[] = [
  ["record query", "GET", "/data/records", true, true],
  ["one record", "GET", `/data/records/${ID}`, true, true],
  ["metadata query", "GET", "/data/metadata/image", true, true],
  ["one record's metadata", "GET", `/data/records/${ID}/metadata/image`, true, true],
  ["labels", "GET", "/data/labels", true, true],
  ["types", "GET", "/data/types", true, true],
  ["label keys", "GET", "/data/label-keys", true, true],
  ["file URL", "GET", `/data/records/${ID}/file-url`, true, true],
  ["file URLs (a POST read)", "POST", "/data/records/file-urls", true, true],
  ["content URL", "GET", `/data/records/${ID}/content-url`, true, true],
  ["shared file presign GET", "GET", `/files/${KEY}/presign`, true, true],
  ["shared file stat", "GET", `/files/${KEY}/stat`, true, true],
  ["shared file HEAD", "HEAD", `/files/${KEY}`, true, true],
  ["app rows", "GET", "/app-data/db/probe_notes", true, true],
  ["app file list", "GET", "/app-data/files", true, true],
  ["app file", "GET", "/app-data/files/a/b.txt", true, true],
  ["app file URLs (a POST read)", "POST", "/app-data/file-urls", true, true],

  ["record write", "POST", "/data/records", false, true],
  ["file write", "POST", "/data/files", false, true],
  ["presign upload", "POST", "/files/presign", false, true],
  ["presign batch", "POST", "/files/presign-batch", false, true],
  ["multipart presign", "POST", "/files/multipart/presign", false, true],
  ["multipart complete", "POST", "/files/multipart/complete", false, true],
  ["metadata write", "POST", `/data/records/${ID}/metadata`, false, true],
  ["fidelity", "POST", `/data/records/${ID}/fidelity`, false, true],
  ["app row insert", "POST", "/app-data/db/probe_notes", false, true],
  ["app row patch", "PATCH", "/app-data/db/probe_notes", false, true],
  ["app file presign", "POST", "/app-data/files/presign", false, true],
  ["app file record", "POST", "/app-data/files/a/b.txt/record", false, true],

  ["label write", "POST", "/data/labels", true, true],
  ["label values", "POST", "/data/labels/values", true, true],
  ["label retract", "POST", "/data/labels/retract", true, true],

  ["record to the Trash", "DELETE", `/data/records/${ID}`, false, true],
  ["app row tombstone", "DELETE", "/app-data/db/probe_notes", false, true],

  ["shared file erase", "DELETE", `/files/${KEY}`, false, false],
  ["app file erase", "DELETE", "/app-data/files/a/b.txt", false, false],
  ["reap", "POST", "/data/reap", false, false],
  ["archive restore", "POST", `/data/records/${ID}/restore`, false, false],
  ["sync exchange", "POST", "/sync/exchange", false, false],
  ["public share list", "GET", "/data/public-shares", false, false],
  ["public share create", "POST", "/data/public-shares", false, false],
  ["public share delete", "DELETE", "/data/public-shares/0000-1111", false, false],
  ["stand-in backlog", "GET", "/data/stand-ins/backlog", false, false],
  ["deployment settings", "GET", "/deployment/settings", false, false],
  ["trash listing", "GET", "/data/trash", false, false],
  ["health", "GET", "/health", false, false],
  ["an unknown route", "GET", "/data/something-new", false, false],
  ["a wrong method on a known path", "PUT", "/data/records", false, false],
];

describe("delegatedMayCall", () => {
  it.each(TABLE)("%s: %s %s", (_label, method, path, read, readwrite) => {
    expect(delegatedMayCall("read", method, path)).toBe(read);
    expect(delegatedMayCall("readwrite", method, path)).toBe(readwrite);
  });
});

describe("isDelegatedWrite", () => {
  it("counts writes and label writes, not reads", () => {
    expect(isDelegatedWrite("POST", "/app-data/db/probe_notes")).toBe(true);
    expect(isDelegatedWrite("POST", "/data/labels")).toBe(true);
    expect(isDelegatedWrite("POST", "/data/records/file-urls")).toBe(false);
    expect(isDelegatedWrite("GET", "/data/records")).toBe(false);
  });
});

import type { SyncStateStore, Watermarks } from "../../src/types.js";

/**
 * An in-memory `SyncStateStore` for tests.
 *
 * One implementation rather than a copy per test file. There were six, and when
 * the store grew a method every one of them had to be found and updated — which
 * is a poor reason for a test suite to go red, and a good way for a test file to
 * quietly keep exercising a stale contract.
 */
export function createMemorySyncStateStore(): SyncStateStore {
  let watermarks: Watermarks = {};
  let peerWatermarks: Watermarks = {};
  let repairFloors: Watermarks = {};
  let inboundFloors: Watermarks = {};
  return {
    async getWatermarks() {
      return watermarks;
    },
    async setWatermarks(w) {
      watermarks = w;
    },
    async getPeerWatermarks() {
      return peerWatermarks;
    },
    async setPeerWatermarks(w) {
      peerWatermarks = w;
    },
    async getRepairFloors() {
      return repairFloors;
    },
    async setRepairFloors(f) {
      repairFloors = f;
    },
    async getInboundFloors() {
      return inboundFloors;
    },
    async setInboundFloors(f) {
      inboundFloors = f;
    },
    async getHlcClockState() {
      return null;
    },
    async setHlcClockState() {},
  };
}

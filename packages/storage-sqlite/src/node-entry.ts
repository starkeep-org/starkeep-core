/**
 * `@starkeep/storage-sqlite/node` — the Node-only entry point.
 *
 * Everything portable stays on the main entry. This one exists solely so that
 * importing the Node driver is an explicit act, and so the main entry can be
 * bundled for React Native without `node:sqlite` in its import graph.
 */

export { nodeSqliteDriver } from "./node-driver.js";

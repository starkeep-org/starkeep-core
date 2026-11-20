/**
 * `createDsqlPool` against a server that never closes its side (STA-102).
 *
 * The fake server answers the startup handshake, then ignores everything,
 * including the Terminate message. Half-open mode keeps its side of the socket
 * open after the client's FIN, which is how a dead DSQL socket looks from the
 * client: `pool.end()` resolves, but the client's close never finishes.
 *
 * The test drives the real pg-pool and pg client.
 */
import net from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDsqlPool, DSQL_CLOSE_GRACE_MS } from "../src/dsql-pool";

// AuthenticationOk ('R', length 8, code 0), then ReadyForQuery ('Z', length 5, idle).
const HANDSHAKE = Buffer.from([0x52, 0, 0, 0, 8, 0, 0, 0, 0, 0x5a, 0, 0, 0, 5, 0x49]);

const sockets = new Set<net.Socket>();

async function startSilentServer(): Promise<{ server: net.Server; port: number }> {
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket);
    socket.once("data", () => socket.write(HANDSHAKE));
    socket.on("error", () => {});
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: (server.address() as net.AddressInfo).port };
}

describe("createDsqlPool", () => {
  let server: net.Server | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = undefined;
  });

  async function endedPoolClient(closeGraceMs: number) {
    const started = await startSilentServer();
    server = started.server;
    const pool = createDsqlPool(
      { host: "127.0.0.1", port: started.port, user: "admin", database: "postgres", max: 1 },
      { label: "fake-cluster", closeGraceMs },
    );
    const client = await pool.connect();
    client.release();
    const closed = new Promise<void>((resolve) => client.once("end", () => resolve()));
    await pool.end();
    const stream = (client as unknown as { connection: { stream: net.Socket } }).connection.stream;
    return { stream, closed };
  }

  it("downgrades a socket error on a client the pool has already ended to a warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { stream } = await endedPoolClient(DSQL_CLOSE_GRACE_MS);

    // pg-pool leaves its idle listener on the ending client, so this error
    // reaches the pool. Without a pool listener, emit() throws and, outside a
    // test, crashes the process.
    const timeout = Object.assign(new Error("read ETIMEDOUT"), { code: "ETIMEDOUT" });
    expect(() => stream.emit("error", timeout)).not.toThrow();
    expect(warn).toHaveBeenCalledWith(
      "[diag] idle DSQL connection error (fake-cluster): read ETIMEDOUT",
    );
  });

  it("destroys a closing socket the server never closes once the grace period passes", async () => {
    const { stream, closed } = await endedPoolClient(50);

    // pool.end() has resolved, yet the socket is still open: the server
    // ignored Terminate and kept its side open.
    expect(stream.destroyed).toBe(false);
    await closed;
    expect(stream.destroyed).toBe(true);
  });
});

import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { get, type ClientRequest, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { AppDatabase, databaseLockPath } from "../src/db.js";

const SHUTDOWN_BOUND_MS = 1_000;
const CLEANUP_BOUND_MS = 2_000;

async function within<T>(work: Promise<T>, milliseconds: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), milliseconds);
      }),
    ]);
  } finally {
    if (timer != null) clearTimeout(timer);
  }
}

function waitForHeldResponse(url: string): Promise<{
  request: ClientRequest;
  response: IncomingMessage;
}> {
  return new Promise((resolve, reject) => {
    const request = get(url, (response) => {
      const onError = (error: Error) => reject(error);
      response.once("error", onError);
      response.once("data", () => {
        response.off("error", onError);
        response.on("error", () => {});
        resolve({ request, response });
      });
    });
    request.once("error", reject);
  });
}

async function closeForCleanup(app: FastifyInstance | undefined): Promise<void> {
  if (app == null) return;
  await within(
    app.close().catch(() => {}),
    CLEANUP_BOUND_MS,
    "test cleanup could not close Fastify",
  ).catch(() => {});
}

function testConfig(databasePath: string, dataDir: string) {
  return {
    databasePath,
    dataDir,
    secretKey: randomBytes(32),
    cookieSecure: false,
    logger: false,
    updateCheck: false,
  } as const;
}

describe("server shutdown connection draining", () => {
  it("forces an active HTTP stream closed before releasing the database lock", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "yawf-shutdown-stream-"));
    const databasePath = join(dataDir, "app.sqlite");
    const lockPath = databaseLockPath(databasePath);
    let app: FastifyInstance | undefined;
    let request: ClientRequest | undefined;
    let response: IncomingMessage | undefined;
    let reopened: AppDatabase | undefined;

    try {
      app = await buildApp({ config: testConfig(databasePath, dataDir) });
      app.get("/__test/held-response", async (_request, reply) => {
        reply.hijack();
        reply.raw.writeHead(200, { "content-type": "application/octet-stream" });
        reply.raw.write("held");
      });
      const address = await app.listen({ host: "127.0.0.1", port: 0 });
      ({ request, response } = await waitForHeldResponse(
        `${address}/__test/held-response`,
      ));
      expect(response.complete).toBe(false);
      expect(existsSync(lockPath)).toBe(true);

      const disconnected = response.destroyed
        ? Promise.resolve()
        : new Promise<void>((resolve) => response?.once("close", resolve));
      await within(
        app.close(),
        SHUTDOWN_BOUND_MS,
        "Fastify did not close while an HTTP response remained active",
      );
      await within(
        disconnected,
        SHUTDOWN_BOUND_MS,
        "the active HTTP client was not disconnected during shutdown",
      );

      expect(response.destroyed).toBe(true);
      expect(response.complete).toBe(false);
      expect(existsSync(lockPath)).toBe(false);
      reopened = new AppDatabase(databasePath);
      expect(existsSync(lockPath)).toBe(true);
      reopened.close();
      reopened = undefined;
      expect(existsSync(lockPath)).toBe(false);
    } finally {
      request?.destroy();
      response?.destroy();
      reopened?.close();
      await closeForCleanup(app);
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("still performs a normal close when no response is active", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "yawf-shutdown-normal-"));
    const databasePath = join(dataDir, "app.sqlite");
    const lockPath = databaseLockPath(databasePath);
    let app: FastifyInstance | undefined;
    let reopened: AppDatabase | undefined;

    try {
      app = await buildApp({ config: testConfig(databasePath, dataDir) });
      await app.listen({ host: "127.0.0.1", port: 0 });
      expect(existsSync(lockPath)).toBe(true);
      await within(
        app.close(),
        SHUTDOWN_BOUND_MS,
        "Fastify did not complete a normal close",
      );
      expect(existsSync(lockPath)).toBe(false);
      reopened = new AppDatabase(databasePath);
      reopened.close();
      reopened = undefined;
      expect(existsSync(lockPath)).toBe(false);
    } finally {
      reopened?.close();
      await closeForCleanup(app);
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

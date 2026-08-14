import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { installGracefulShutdown } from "../src/shutdown.js";

function fixture(close = vi.fn(async () => {})) {
  const runtime = new EventEmitter() as EventEmitter & { exitCode?: number };
  const log = {
    info: vi.fn(),
    error: vi.fn(),
  };
  const remove = installGracefulShutdown(
    { close, log } as never,
    runtime,
  );
  return { close, log, remove, runtime };
}

describe("graceful server shutdown", () => {
  it("closes Fastify exactly once when a container stop sends SIGTERM", async () => {
    const subject = fixture();
    subject.runtime.emit("SIGTERM");
    subject.runtime.emit("SIGTERM");
    subject.runtime.emit("SIGINT");
    await vi.waitFor(() => expect(subject.close).toHaveBeenCalledTimes(1));
    expect(subject.log.info).toHaveBeenCalledWith(
      { signal: "SIGTERM" },
      "Graceful server shutdown started.",
    );
    subject.remove();
  });

  it("sets a failing exit code when Fastify cannot close", async () => {
    const failure = new Error("close failed");
    const subject = fixture(vi.fn(async () => { throw failure; }));
    subject.runtime.emit("SIGINT");
    await vi.waitFor(() => expect(subject.runtime.exitCode).toBe(1));
    expect(subject.log.error).toHaveBeenCalledWith(
      { err: failure, signal: "SIGINT" },
      "Graceful server shutdown failed.",
    );
    subject.remove();
  });
});

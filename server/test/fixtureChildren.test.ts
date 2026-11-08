import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FixtureChildren, type FixtureChild } from "./helpers/fixtureChildren.js";

const owners: FixtureChildren[] = [];
const doubles: Array<{ close(): void }> = [];
function owner(waitMs = 10, cleanupMs = 5): FixtureChildren {
  const result = new FixtureChildren(waitMs, cleanupMs);
  owners.push(result);
  return result;
}
function childDouble() {
  const child = new EventEmitter();
  const stdout = Object.assign(new EventEmitter(), { setEncoding: vi.fn() });
  const stderr = Object.assign(new EventEmitter(), { setEncoding: vi.fn() });
  const kill = vi.fn(() => true);
  const streamChild = Object.assign(child, { stdout, stderr, kill });
  let exited = false;
  let closed = false;
  const exit = () => { if (!exited) { exited = true; child.emit("exit", 0, null); } };
  const close = () => {
    if (closed) return;
    closed = true; exit(); child.emit("close", 0, null);
  };
  const result = { child: streamChild as unknown as FixtureChild["child"], stdout, stderr, kill, exit, close };
  doubles.push(result);
  return result;
}

afterEach(async () => {
  // Controlled doubles cannot be allowed to strand a deliberately failed mutant.
  for (const child of doubles.splice(0)) child.close();
  for (const children of owners.splice(0)) await children.cleanup();
  vi.useRealTimers();
});

describe("fixture child ownership", () => {
  it("retains a live child when its readiness wait expires", async () => {
    vi.useFakeTimers();
    const children = owner(), child = childDouble();
    const tracked = children.track(child.child, new AbortController().signal);
    const waiting = expect(tracked.waitForOutput("ready\n")).rejects.toThrow("readiness");
    await vi.advanceTimersByTimeAsync(10); await waiting;
    expect(children.size).toBe(1);
    child.close(); expect(children.size).toBe(0);
  });

  it("aborts pending readiness without forgetting the still-live child", async () => {
    const children = owner(), child = childDouble(), controller = new AbortController();
    const tracked = children.track(child.child, controller.signal);
    const reason = new Error("controlled test cancellation");
    const waiting = expect(tracked.waitForOutput("ready\n")).rejects.toBe(reason);
    controller.abort(reason); await waiting;
    expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
    expect(children.size).toBe(1);
    child.stdout.emit("data", "ready\n");
    controller.abort(reason);
    expect(child.kill).toHaveBeenCalledTimes(1);
    child.close(); expect(children.size).toBe(0);
  });

  it("does not allow directory cleanup after its close deadline expires", async () => {
    vi.useFakeTimers();
    const children = owner(), child = childDouble();
    children.track(child.child, new AbortController().signal);
    let directoryDeleted = false;
    const cleanup = children.cleanup().then(() => { directoryDeleted = true; });
    const rejected = expect(cleanup).rejects.toThrow("cleanup close");
    await vi.advanceTimersByTimeAsync(5); await rejected;
    expect(children.size).toBe(1); expect(directoryDeleted).toBe(false);
    child.close(); await children.cleanup();
    expect(children.size).toBe(0);
  });

  it("waits beyond exit for close and the final stdout and stderr bytes", async () => {
    const children = owner(), child = childDouble();
    const tracked = children.track(child.child, new AbortController().signal);
    let settled = false;
    const waiting = tracked.waitForClose().then((result) => { settled = true; return result; });
    child.exit(); await Promise.resolve(); await Promise.resolve();
    expect(settled).toBe(false); expect(children.size).toBe(1);
    child.stdout.emit("data", "final stdout\n"); child.stderr.emit("data", "final stderr\n");
    child.close();
    await expect(waiting).resolves.toEqual({ code: 0, signal: null });
    expect(tracked.output()).toEqual({ stdout: "final stdout\n", stderr: "final stderr\n" });
    expect(children.size).toBe(0);
  });

  it("cancels a close wait after readiness but still drains actual close", async () => {
    const children = owner(), child = childDouble(), controller = new AbortController();
    const tracked = children.track(child.child, controller.signal);
    child.stdout.emit("data", "ready\n"); await tracked.waitForOutput("ready\n");
    const reason = new Error("cancel after readiness");
    const waiting = expect(tracked.waitForClose()).rejects.toBe(reason);
    controller.abort(reason); await waiting;
    let cleaned = false;
    const cleanup = children.cleanup().then(() => { cleaned = true; });
    child.exit(); await Promise.resolve();
    expect(cleaned).toBe(false); expect(children.size).toBe(1);
    child.close(); await cleanup;
    expect(child.kill).toHaveBeenCalledTimes(1); expect(children.size).toBe(0);
  });

  it("registers a pre-aborted child before synchronous termination can close it", async () => {
    const children = owner(), child = childDouble(), controller = new AbortController();
    controller.abort(); child.kill.mockImplementation(() => { child.close(); return true; });
    children.track(child.child, controller.signal);
    expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
    expect(children.size).toBe(0); await children.cleanup();
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it("reports spawn failure without releasing ownership before close", async () => {
    const children = owner(), child = childDouble();
    const tracked = children.track(child.child, new AbortController().signal);
    const error = new Error("controlled spawn failure");
    const waiting = expect(tracked.waitForOutput("ready\n")).rejects.toBe(error);
    expect(() => child.child.emit("error", error)).not.toThrow(); await waiting;
    expect(children.size).toBe(1);
    child.close(); await expect(tracked.waitForClose()).rejects.toBe(error);
    expect(children.size).toBe(0);
  });

  it("does not accept buffered readiness or close after cancellation", async () => {
    const children = owner(), child = childDouble(), controller = new AbortController();
    const tracked = children.track(child.child, controller.signal);
    child.stdout.emit("data", "ready\n"); child.close();
    const reason = new Error("canceled before a later wait"); controller.abort(reason);
    await expect(tracked.waitForOutput("ready\n")).rejects.toBe(reason);
    await expect(tracked.waitForClose()).rejects.toBe(reason);
    expect(children.size).toBe(0); await children.cleanup();
  });

  it("does not cancel an independent sibling fixture", async () => {
    const children = owner(), first = childDouble(), second = childDouble();
    const controller = new AbortController();
    children.track(first.child, controller.signal);
    const sibling = children.track(second.child, new AbortController().signal);
    controller.abort();
    expect(first.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
    expect(second.kill).not.toHaveBeenCalled(); expect(children.size).toBe(2);
    second.stdout.emit("data", "ready\n"); await sibling.waitForOutput("ready\n");
    first.close(); expect(children.size).toBe(1);
    second.close(); expect(children.size).toBe(0);
  });

  it.each(["closed without readiness", "recorded spawn failure"] as const)(
    "preserves abort precedence without an unhandled inner rejection after %s",
    async (terminal) => {
      const children = owner(), child = childDouble(), controller = new AbortController();
      const tracked = children.track(child.child, controller.signal);
      // A default spy forwards emit unchanged. Adding another rejection
      // listener would make Vitest classify the error as user-handled.
      const emit = vi.spyOn(process, "emit");
      try {
        if (terminal === "closed without readiness") child.close();
        else child.child.emit("error", new Error("recorded fixture spawn failure"));
        const reason = new Error("abort takes precedence"); controller.abort(reason);
        await expect(tracked.waitForOutput("ready\n")).rejects.toBe(reason);
        // A real event-loop turn exposes rejected inner promises to Node and
        // Vitest. Do not remove or suppress either observer's diagnostics.
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(emit.mock.calls.filter(([event]) => String(event) === "unhandledRejection")).toEqual([]);
      } finally {
        emit.mockRestore();
      }
    },
  );

  it("drains an actual owned process during cancellation cleanup", async ({ signal }) => {
    const children = owner(1_000, 1_000), controller = new AbortController();
    const child = spawn(process.execPath, ["-e", "process.stdout.write('ready\\n'); setInterval(() => {}, 60000)"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
    const tracked = children.track(child, AbortSignal.any([signal, controller.signal]));
    try {
      await tracked.waitForOutput("ready\n");
      controller.abort(); await children.cleanup();
      expect(children.size).toBe(0);
      expect(child.exitCode != null || child.signalCode != null).toBe(true);
      await closed;
    } finally {
      // Independent final safety for a kill-suppression mutant of the helper.
      child.kill("SIGKILL"); await closed;
    }
  });
});

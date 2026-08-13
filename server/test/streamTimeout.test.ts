import { afterEach, describe, expect, it, vi } from "vitest";
import { Writable } from "node:stream";
import { once } from "node:events";
import {
  demandAwareNodeReadable,
  streamWithIdleTimeout,
  waitForUpstreamResponse,
} from "../src/streamTimeout.js";

afterEach(() => vi.useRealTimers());

describe("stream proxy timeouts", () => {
  it("fails before response headers and clears its timer", async () => {
    vi.useFakeTimers();
    const abort = new AbortController();
    const pending = waitForUpstreamResponse(
      () => new Promise<Response>((_resolve, reject) => {
        abort.signal.addEventListener("abort", () => reject(abort.signal.reason));
      }),
      abort,
      100,
    );
    const assertion = expect(pending).rejects.toMatchObject({ statusCode: 504 });
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects at the deadline when the upstream operation ignores abort", async () => {
    vi.useFakeTimers();
    const abort = new AbortController();
    const pending = waitForUpstreamResponse(
      () => new Promise<Response>(() => {}),
      abort,
      100,
    );
    const assertion = expect(pending).rejects.toMatchObject({ statusCode: 504 });
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
    expect(abort.signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts a body that sends bytes and then stalls", async () => {
    vi.useFakeTimers();
    let source!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(controller) { source = controller; } });
    const abort = new AbortController();
    const cleanup = vi.fn();
    const reader = streamWithIdleTimeout(body, abort, 100, cleanup).getReader();
    source.enqueue(new Uint8Array([1, 2]));
    await expect(reader.read()).resolves.toMatchObject({ value: new Uint8Array([1, 2]) });
    const stalled = reader.read();
    const assertion = expect(stalled).rejects.toMatchObject({ statusCode: 504 });
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
    expect(abort.signal.aborted).toBe(true);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("allows a long progressive response when every chunk resets the idle timer", async () => {
    vi.useFakeTimers();
    let source!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(controller) { source = controller; } });
    const cleanup = vi.fn();
    const reader = streamWithIdleTimeout(body, new AbortController(), 100, cleanup).getReader();
    for (let value = 1; value <= 3; value += 1) {
      source.enqueue(new Uint8Array([value]));
      await expect(reader.read()).resolves.toMatchObject({ done: false });
      await vi.advanceTimersByTimeAsync(90);
    }
    source.close();
    await expect(reader.read()).resolves.toEqual({ done: true, value: undefined });
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not count downstream backpressure as upstream idleness", async () => {
    vi.useFakeTimers();
    let source!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(controller) { source = controller; } });
    const abort = new AbortController();
    const reader = streamWithIdleTimeout(body, abort, 100).getReader();
    source.enqueue(new Uint8Array([1]));
    await expect(reader.read()).resolves.toMatchObject({ done: false });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(abort.signal.aborted).toBe(false);
    source.enqueue(new Uint8Array([2]));
    await expect(reader.read()).resolves.toMatchObject({ value: new Uint8Array([2]) });
    source.close();
    await expect(reader.read()).resolves.toMatchObject({ done: true });
  });

  it("does not prefetch upstream while a Node response write is blocked", async () => {
    vi.useFakeTimers();
    let source!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(controller) { source = controller; } });
    const abort = new AbortController();
    let countedBytes = 0;
    const bridged = demandAwareNodeReadable(
      streamWithIdleTimeout(body, abort, 100),
      (bytes) => { countedBytes += bytes; },
    );
    let releaseFirstWrite!: () => void;
    let firstWriteStarted!: () => void;
    const firstWrite = new Promise<void>((resolve) => { firstWriteStarted = resolve; });
    const received: number[] = [];
    const output = new Writable({
      highWaterMark: 1,
      write(chunk: Buffer, _encoding, callback) {
        received.push(...chunk);
        if (received.length === 1) {
          releaseFirstWrite = callback;
          firstWriteStarted();
        } else {
          callback();
        }
      },
    });
    bridged.pipe(output);
    source.enqueue(new Uint8Array([1]));
    await firstWrite;

    await vi.advanceTimersByTimeAsync(1_000);
    expect(abort.signal.aborted).toBe(false);

    releaseFirstWrite();
    source.enqueue(new Uint8Array([2]));
    source.close();
    await once(output, "finish");
    expect(received).toEqual([1, 2]);
    expect(countedBytes).toBe(2);
    expect(abort.signal.aborted).toBe(false);
  });
});

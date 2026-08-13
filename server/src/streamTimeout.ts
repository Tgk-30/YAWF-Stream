import { Readable } from "node:stream";

export const DEFAULT_UPSTREAM_RESPONSE_TIMEOUT_MS = 20_000;
export const DEFAULT_UPSTREAM_IDLE_TIMEOUT_MS = 30_000;

export function upstreamTimeoutError(phase: "response" | "idle"): Error & {
  statusCode: number;
} {
  const error = new Error(
    phase === "response"
      ? "The upstream stream did not respond in time."
      : "The upstream stream stopped sending data.",
  ) as Error & { statusCode: number };
  error.statusCode = 504;
  return error;
}

export async function waitForUpstreamResponse<T>(
  operation: () => Promise<T>,
  controller: AbortController,
  timeoutMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<T>((resolve, reject) => {
      timer = setTimeout(() => {
        const error = upstreamTimeoutError("response");
        controller.abort(error);
        reject(error);
      }, timeoutMs);
      timer.unref?.();
      void operation().then(resolve, reject);
    });
  } finally {
    clearTimeout(timer);
  }
}

/** Bound gaps between chunks without imposing a total playback-duration limit. */
export function streamWithIdleTimeout(
  body: ReadableStream<Uint8Array>,
  controller: AbortController,
  timeoutMs: number,
  onDone: () => void = () => {},
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let finished = false;
  let outputController: ReadableStreamDefaultController<Uint8Array> | null = null;

  const finish = () => {
    if (finished) return false;
    finished = true;
    clearTimeout(timer);
    onDone();
    return true;
  };
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (!finish()) return;
      const error = upstreamTimeoutError("idle");
      controller.abort(error);
      void reader.cancel(error).catch(() => {});
      outputController?.error(error);
    }, timeoutMs);
    timer.unref?.();
  };

  return new ReadableStream<Uint8Array>({
    start(output) {
      outputController = output;
    },
    async pull(output) {
      if (finished) return;
      arm();
      try {
        const chunk = await reader.read();
        clearTimeout(timer);
        timer = undefined;
        if (finished) return;
        if (chunk.done) {
          finish();
          output.close();
          return;
        }
        output.enqueue(chunk.value);
      } catch (error) {
        clearTimeout(timer);
        timer = undefined;
        if (finish()) output.error(error);
      }
    },
    cancel(reason) {
      if (!finished) {
        finished = true;
        clearTimeout(timer);
        onDone();
      }
      controller.abort(reason);
      return reader.cancel(reason).catch(() => {});
    },
  }, { highWaterMark: 0 });
}

/** Preserve web-stream demand across Node's bridge instead of prefetching
 * while a downstream socket is applying backpressure. */
export function demandAwareNodeReadable(
  body: ReadableStream<Uint8Array>,
  onChunk: (bytes: number) => void = () => {},
): Readable {
  const reader = body.getReader();
  const counted = new ReadableStream<Uint8Array>({
    async pull(output) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          output.close();
          return;
        }
        onChunk(chunk.value.byteLength);
        output.enqueue(chunk.value);
      } catch (error) {
        output.error(error);
      }
    },
    cancel(reason) {
      return reader.cancel(reason).catch(() => {});
    },
  }, { highWaterMark: 0 });
  return Readable.fromWeb(counted, { highWaterMark: 0 });
}

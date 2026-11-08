import type { ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";

type FixtureProcess = ChildProcessByStdio<null, Readable, Readable>;

export interface FixtureExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface FixtureChild {
  child: FixtureProcess;
  closed: Promise<FixtureExit>;
  output(): { stdout: string; stderr: string };
  waitForOutput(marker: string): Promise<void>;
  waitForClose(): Promise<FixtureExit>;
  stop(signal: NodeJS.Signals): Promise<FixtureExit>;
  dispose(): Promise<void>;
}

// Test fixture ownership ends at close, never at a wait deadline or exit.
export class FixtureChildren {
  private readonly active = new Set<FixtureChild>();

  constructor(
    private readonly waitTimeoutMs: number,
    private readonly cleanupTimeoutMs: number,
  ) {}

  get size(): number { return this.active.size; }

  track(child: FixtureProcess, signal: AbortSignal): FixtureChild {
    let stdout = "";
    let stderr = "";
    let exited = false;
    let closed = false;
    let spawnError: Error | null = null;
    let lastSignal: NodeJS.Signals | null = null;
    const changed = new Set<() => void>();
    const notify = () => { for (const listener of changed) listener(); };
    let resolveClose!: (result: FixtureExit) => void;
    const close = new Promise<FixtureExit>((resolve) => { resolveClose = resolve; });
    const kill = (requested: NodeJS.Signals) => {
      if (exited || closed || lastSignal === requested) return;
      lastSignal = requested;
      child.kill(requested);
    };
    const abort = () => kill("SIGKILL");
    const wait = async <T>(promise: Promise<T>, phase: string, timeoutMs: number, abortSignal?: AbortSignal): Promise<T> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let onAbort: (() => void) | undefined;
      try {
        // Cancellation can win before Promise.race subscribes to an already
        // rejected operation. Observe it without changing its normal result.
        void promise.catch(() => {});
        if (abortSignal?.aborted) throw abortSignal.reason;
        const result = await Promise.race([
          promise,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`Fixture child ${phase} timed out: ${stderr}`)), timeoutMs);
            if (abortSignal != null) {
              onAbort = () => reject(abortSignal.reason ?? new Error(`Fixture child ${phase} aborted.`));
              abortSignal.addEventListener("abort", onAbort, { once: true });
              if (abortSignal.aborted) onAbort();
            }
          }),
        ]);
        if (abortSignal?.aborted) throw abortSignal.reason;
        return result;
      } finally {
        if (timer != null) clearTimeout(timer);
        if (onAbort != null) abortSignal?.removeEventListener("abort", onAbort);
      }
    };
    const owned: FixtureChild = {
      child,
      closed: close,
      output: () => ({ stdout, stderr }),
      waitForOutput: async (marker) => {
        let check!: () => void;
        const ready = new Promise<void>((resolve, reject) => {
          check = () => {
            if (spawnError != null) reject(spawnError);
            else if (stdout.includes(marker)) resolve();
            else if (closed) reject(new Error(`Fixture child closed before ${JSON.stringify(marker)}: ${stderr}`));
          };
          changed.add(check);
          check();
        });
        try {
          await wait(ready, `readiness ${JSON.stringify(marker)}`, this.waitTimeoutMs, signal);
        } finally {
          changed.delete(check);
        }
      },
      waitForClose: async () => {
        const result = await wait(close, "close", this.waitTimeoutMs, signal);
        if (spawnError != null) throw spawnError;
        return result;
      },
      stop: async (requested) => {
        kill(requested);
        return owned.waitForClose();
      },
      dispose: async () => {
        kill("SIGKILL");
        await wait(close, "cleanup close", this.cleanupTimeoutMs);
      },
    };
    // Register before an already-aborted signal can synchronously stop it.
    this.active.add(owned);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; notify(); });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", (error) => { spawnError = error; notify(); });
    child.once("exit", () => { exited = true; });
    child.once("close", (code, childSignal) => {
      closed = true;
      signal.removeEventListener("abort", abort);
      this.active.delete(owned);
      notify();
      resolveClose({ code, signal: childSignal });
    });
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    return owned;
  }

  async cleanup(): Promise<void> {
    await Promise.all([...this.active].map((child) => child.dispose()));
  }
}

export const POST_START_STALL_TIMEOUT_MS = 30_000;
export const FRESH_STREAM_RESOLUTION_TIMEOUT_MS = 20_000;

export function withFreshStreamResolutionTimeout<T>(
  operation: Promise<T>,
  timeoutMs = FRESH_STREAM_RESOLUTION_TIMEOUT_MS,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = globalThis.setTimeout(() => {
      reject(new Error("Fresh stream resolution timed out."));
    }, timeoutMs);
    void operation.then(
      (value) => {
        globalThis.clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        globalThis.clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export function playbackRecoverySessionIdentity(
  mediaId: string,
  episodeId: string | null,
  sourceHash: string | null,
  url: string,
): string {
  return `${mediaId}\u0000${episodeId ?? "movie"}\u0000${sourceHash ?? url}`;
}

export interface PlaybackStallState {
  started: boolean;
  paused: boolean;
  seeking: boolean;
  suspended: boolean;
  ended: boolean;
  tearingDown: boolean;
}

export function playbackExpectedToAdvance(state: PlaybackStallState): boolean {
  return (
    state.started &&
    !state.paused &&
    !state.seeking &&
    !state.suspended &&
    !state.ended &&
    !state.tearingDown
  );
}

type TimerHandle = ReturnType<typeof globalThis.setTimeout>;

/** A resettable post-start watchdog shared by the webview and native players. */
export class PlaybackStallWatchdog {
  private timer: TimerHandle | undefined;
  private state: PlaybackStallState = {
    started: false,
    paused: false,
    seeking: false,
    suspended: false,
    ended: false,
    tearingDown: false,
  };

  constructor(
    private readonly onStall: () => void,
    private readonly timeoutMs = POST_START_STALL_TIMEOUT_MS,
  ) {}

  update(state: PlaybackStallState): void {
    this.state = state;
    if (playbackExpectedToAdvance(state)) {
      if (this.timer == null) this.arm();
    } else {
      this.clear();
    }
  }

  noteProgress(): void {
    if (!playbackExpectedToAdvance(this.state)) return;
    this.arm();
  }

  stop(): void {
    this.state = { ...this.state, tearingDown: true };
    this.clear();
  }

  private arm(): void {
    this.clear();
    this.timer = globalThis.setTimeout(() => {
      this.timer = undefined;
      if (playbackExpectedToAdvance(this.state)) this.onStall();
    }, this.timeoutMs);
  }

  private clear(): void {
    if (this.timer != null) globalThis.clearTimeout(this.timer);
    this.timer = undefined;
  }
}

export const RECOVERY_REARM_PROGRESS_MS = 60_000;
const MAX_HEALTHY_SAMPLE_GAP_MS = 5_000;

/** Earn recovery only from a contiguous, plausible playing clock, never a seek or wall-time gap. */
export class PlaybackRecoveryProgress {
  private previous: { nowMs: number; position: number; rate: number } | null = null;
  private progressMs = 0;

  reset(): void {
    this.previous = null;
    this.progressMs = 0;
  }

  note(nowMs: number, position: number, rate: number, eligible: boolean): boolean {
    if (!eligible || !Number.isFinite(nowMs) || !Number.isFinite(position) || position < 0 ||
        !Number.isFinite(rate) || rate <= 0) {
      this.reset();
      return false;
    }
    const previous = this.previous;
    this.previous = { nowMs, position, rate };
    if (previous == null) return false;
    const elapsedMs = nowMs - previous.nowMs;
    const advanced = position - previous.position;
    if (elapsedMs <= 0 || elapsedMs > MAX_HEALTHY_SAMPLE_GAP_MS || rate !== previous.rate || advanced <= 0 ||
        advanced > elapsedMs / 1000 * rate + 0.25) {
      this.progressMs = 0;
      return false;
    }
    this.progressMs += Math.min(elapsedMs, advanced / rate * 1000);
    return this.progressMs >= RECOVERY_REARM_PROGRESS_MS;
  }
}

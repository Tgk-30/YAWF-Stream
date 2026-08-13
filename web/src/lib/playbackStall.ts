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

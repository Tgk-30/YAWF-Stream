/** A sustained owned media-clock AND (when observable) decoded-frame hold.
 * Fresh samples and actual earlier clock progress are mandatory. Buffer ranges
 * and playing/canplay events deliberately provide no evidence here.
 */
export const PLAYBACK_CLOCK_STALL_MS = 12_000;
export const PLAYBACK_CLOCK_SAMPLE_MS = 500;
const MAX_SAMPLE_GAP_MS = 1_500;
const CLOCK_EPSILON_SECONDS = 0.01;
const CLOCK_REGRESSION_SECONDS = 0.05;

export class PlaybackClockStall {
  private lastAt: number | null = null;
  private intent: number | null = null;
  private highWater = 0;
  private initialClock = 0;
  private initialAt = 0;
  private frames: number | null = null;
  private nativeFrames: number | null = null;
  private clockAdvanced = false;
  private framesAdvanced = false;
  private heldSince = 0;

  reset(): void {
    this.lastAt = null;
    this.intent = null;
    this.clockAdvanced = false;
    this.framesAdvanced = false;
  }

  sample(now: number, position: number, frames: number | null, intent: number, eligible: boolean, nativeFrames: number | null = null): boolean {
    if (!eligible || !Number.isFinite(now) || now < 0 || !Number.isFinite(position) || position < 0 ||
      !Number.isSafeInteger(intent) || (frames != null && (!Number.isSafeInteger(frames) || frames < 0)) ||
      (nativeFrames != null && (!Number.isSafeInteger(nativeFrames) || nativeFrames < 0))) {
      this.reset();
      return false;
    }
    const gap = this.lastAt == null ? null : now - this.lastAt;
    if (gap == null || gap < 0 || gap > MAX_SAMPLE_GAP_MS || intent !== this.intent ||
      (frames == null) !== (this.frames == null) ||
      (frames != null && this.frames != null && frames < this.frames) ||
      (nativeFrames == null) !== (this.nativeFrames == null) ||
      (nativeFrames != null && this.nativeFrames != null && nativeFrames < this.nativeFrames) ||
      position < this.highWater - CLOCK_REGRESSION_SECONDS) {
      this.reset();
      this.lastAt = now;
      this.intent = intent;
      this.highWater = this.initialClock = position;
      this.initialAt = now;
      this.frames = frames;
      this.nativeFrames = nativeFrames;
      this.heldSince = now;
      return false;
    }
    const advanced = position > this.highWater + CLOCK_EPSILON_SECONDS;
    const decoded = (frames != null && this.frames != null && frames > this.frames) ||
      (nativeFrames != null && this.nativeFrames != null && nativeFrames > this.nativeFrames);
    // Same-timestamp callbacks may reset a hold but cannot prove playback or
    // contribute any elapsed time. Atomic admission can recheck that same sample.
    if (advanced && now - this.initialAt >= PLAYBACK_CLOCK_SAMPLE_MS && position > this.initialClock + 0.25) this.clockAdvanced = true;
    if (decoded && now - this.initialAt >= PLAYBACK_CLOCK_SAMPLE_MS) this.framesAdvanced = true;
    if (advanced || decoded) this.heldSince = now;
    if (advanced) this.highWater = position;
    this.frames = frames;
    this.nativeFrames = nativeFrames;
    this.lastAt = now;
    return this.clockAdvanced && ((frames == null && nativeFrames == null) || this.framesAdvanced) && now - this.heldSince >= PLAYBACK_CLOCK_STALL_MS;
  }
}

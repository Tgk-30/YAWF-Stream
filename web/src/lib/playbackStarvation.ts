import type { ServerTranscodeQuality } from "./serverApi";

const CLOCK_REGRESSION_TOLERANCE_SECONDS = 0.05;
const STARVATION_EPISODE_WINDOW_MS = 5 * 60_000;
const STARVATION_EPISODES_BEFORE_REDUCTION = 2;
export const STARVATION_WAIT_CONFIRMATION_MS = 2_000;
const WAIT_CONFIRMATION_MAX_AGE_MS = 5_000;
type WaitingConfirmation = Readonly<{ at: number; position: number; playbackIntent: number }>;

function isWaitingClockSample(position: number, highWater: number): boolean {
  return Number.isFinite(position) && position <= highWater &&
    position >= highWater - CLOCK_REGRESSION_TOLERANCE_SECONDS;
}

/** One foreground episode needs new owned clock progress, not another waiting event. */
export class PlaybackStarvation {
  private lastPosition: number | null = null;
  private progressed = false;
  private resumePosition: number | null = null;
  private episodes: number[] = [];
  private attempted = false;
  private audioInventoryAttempted = false;
  private confirmation: WaitingConfirmation | null = null;

  get waitingConfirmation(): WaitingConfirmation | null { return this.confirmation; }

  cancelWaitingConfirmation(): void { this.confirmation = null; }

  get audioInventoryLoadAttempted(): boolean { return this.audioInventoryAttempted; }

  claimAudioInventoryLoad(): boolean {
    if (this.audioInventoryAttempted || this.attempted) return false;
    this.audioInventoryAttempted = true;
    return true;
  }

  claimAttempt(now: number, eligible: boolean): boolean {
    if (!eligible) { this.interrupt(); return false; }
    this.episodes = this.episodes.filter((at) => now >= at && now - at <= STARVATION_EPISODE_WINDOW_MS);
    if (this.attempted || this.episodes.length < STARVATION_EPISODES_BEFORE_REDUCTION) return false;
    this.attempted = true;
    return true;
  }

  interrupt(): void {
    this.lastPosition = null;
    this.resumePosition = null;
    this.progressed = false;
    this.episodes = [];
    this.confirmation = null;
  }

  progress(position: number, eligible: boolean): void {
    if (!eligible || !Number.isFinite(position)) { this.interrupt(); return; }
    // A settled decoder clock may be slightly behind, but never move the
    // original confirmation anchor or accept forward progress as a stall.
    if (this.confirmation != null && !isWaitingClockSample(position, this.confirmation.position)) this.confirmation = null;
    if (this.lastPosition != null && position < this.lastPosition) {
      // Native decoders can settle a few milliseconds backward after buffer
      // depletion. Keep the high-water sample: this is not resumed progress,
      // and repeated small corrections must not accumulate into a rewind.
      if (position >= this.lastPosition - CLOCK_REGRESSION_TOLERANCE_SECONDS) return;
      this.interrupt();
    }
    this.resumePosition ??= position;
    if (position > this.resumePosition + 0.25) this.progressed = true;
    this.lastPosition = position;
  }

  waiting(now: number, bufferedAhead: number, eligible: boolean, attemptReady = true): boolean {
    if (!eligible) { this.interrupt(); return false; }
    if (this.attempted || !this.progressed || !Number.isFinite(bufferedAhead) || bufferedAhead > 0.5) return false;
    return this.episode(now, attemptReady);
  }

  beginWaitingConfirmation(now: number, position: number, playbackIntent: number, eligible: boolean): WaitingConfirmation | null {
    if (!eligible || !Number.isFinite(now)) { this.interrupt(); return null; }
    this.progress(position, true);
    if (this.attempted || !this.progressed) return null;
    return this.confirmation ??= { at: now, position: this.lastPosition ?? position, playbackIntent };
  }

  confirmWaiting(pending: WaitingConfirmation, now: number, position: number, playbackIntent: number, eligible: boolean, attemptReady = true): boolean {
    if (this.confirmation !== pending) return false;
    if (!eligible || playbackIntent !== pending.playbackIntent) { this.interrupt(); return false; }
    if (!isWaitingClockSample(position, pending.position)) { this.progress(position, true); this.confirmation = null; return false; }
    // A timer is corroboration only while this same wait is recent. Delayed
    // callbacks after a busy/suspended document cannot manufacture an episode.
    const age = now - pending.at;
    if (!Number.isFinite(age) || age < 0 || age > WAIT_CONFIRMATION_MAX_AGE_MS) { this.confirmation = null; return false; }
    if (age < STARVATION_WAIT_CONFIRMATION_MS) return false;
    return this.episode(now, attemptReady);
  }

  private episode(now: number, attemptReady: boolean): boolean {
    this.confirmation = null;
    this.progressed = false;
    this.resumePosition = this.lastPosition;
    this.episodes = this.episodes.filter((at) => now >= at && now - at <= STARVATION_EPISODE_WINDOW_MS);
    this.episodes.push(now);
    return attemptReady && this.claimAttempt(now, true);
  }
}

export function lowerStarvationQuality(
  height: number,
  offered: readonly ServerTranscodeQuality[],
): ServerTranscodeQuality | null {
  if (!Number.isFinite(height) || height <= 360) return null;
  const lower = offered.filter((quality) => quality !== "auto" && parseInt(quality, 10) < height);
  if (height > 480 && lower.includes("480p")) return "480p";
  return lower.sort((a, b) => parseInt(b, 10) - parseInt(a, 10))[0] ?? null;
}

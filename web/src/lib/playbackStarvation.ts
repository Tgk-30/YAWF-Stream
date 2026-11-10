import type { ServerTranscodeQuality } from "./serverApi";

const CLOCK_REGRESSION_TOLERANCE_SECONDS = 0.05;

/** One foreground episode needs new owned clock progress, not another waiting event. */
export class PlaybackStarvation {
  private lastPosition: number | null = null;
  private progressed = false;
  private resumePosition: number | null = null;
  private episodes: number[] = [];
  private attempted = false;
  private audioInventoryAttempted = false;

  get audioInventoryLoadAttempted(): boolean { return this.audioInventoryAttempted; }

  claimAudioInventoryLoad(): boolean {
    if (this.audioInventoryAttempted || this.attempted) return false;
    this.audioInventoryAttempted = true;
    return true;
  }

  claimAttempt(now: number, eligible: boolean): boolean {
    if (!eligible) { this.interrupt(); return false; }
    this.episodes = this.episodes.filter((at) => now >= at && now - at <= 45_000);
    if (this.attempted || this.episodes.length < 3) return false;
    this.attempted = true;
    return true;
  }

  interrupt(): void {
    this.lastPosition = null;
    this.resumePosition = null;
    this.progressed = false;
    this.episodes = [];
  }

  progress(position: number, eligible: boolean): void {
    if (!eligible || !Number.isFinite(position)) { this.interrupt(); return; }
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
    this.progressed = false;
    this.resumePosition = this.lastPosition;
    this.episodes = this.episodes.filter((at) => now >= at && now - at <= 45_000);
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

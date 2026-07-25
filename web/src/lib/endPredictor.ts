/** Deterministic, renderer-neutral next-episode end prediction. */
export interface EndChapter {
  title?: string | null;
  time: number;
}

export interface EndPredictionInput {
  position: number;
  duration: number | null | undefined;
  playing: boolean;
  eligible: boolean;
  chapters?: readonly EndChapter[];
  dismissed?: boolean;
}

export type EndPrediction = {
  show: boolean;
  /** True only when a trusted credits marker permits early transition. */
  earlyAutoAdvance: boolean;
  /** The visible cancel window, always at least ten seconds. */
  cancelWindowSeconds: number;
  reason: "credits" | "duration" | "eof" | "none";
};

const CREDITS_TITLE = /\b(?:end\s*credits?|credits?|outro)\b/i;

/** A bounded prompt window that grows for longer episodes without skipping them. */
export function adaptiveEndWindow(duration: number | null | undefined): number | null {
  if (!Number.isFinite(duration) || duration == null || duration < 60) return null;
  return Math.max(10, Math.min(30, Math.round(duration / 120)));
}

export function predictEpisodeEnd(input: EndPredictionInput): EndPrediction {
  const none: EndPrediction = {
    show: false,
    earlyAutoAdvance: false,
    cancelWindowSeconds: 10,
    reason: "none",
  };
  if (!input.eligible || input.dismissed || !input.playing) return none;
  const duration = input.duration;
  const position = input.position;
  if (!Number.isFinite(duration) || duration == null || duration <= 0 ||
      !Number.isFinite(position) || position < 0) return none;
  const left = duration - position;
  if (left <= 0) return { ...none, show: true, reason: "eof" };

  const trustedCredits = (input.chapters ?? []).some((chapter) =>
    Number.isFinite(chapter.time) && chapter.time >= duration * 0.65 &&
    chapter.time <= position && CREDITS_TITLE.test(chapter.title?.trim() ?? "") &&
    duration - chapter.time >= 15 && duration - chapter.time <= 300,
  );
  if (trustedCredits) {
    return { show: true, earlyAutoAdvance: true, cancelWindowSeconds: 10, reason: "credits" };
  }

  const window = adaptiveEndWindow(duration);
  if (window != null && left <= window) {
    return { show: true, earlyAutoAdvance: false, cancelWindowSeconds: 10, reason: "duration" };
  }
  return none;
}

/** Screen-space bounds. The video's bounds already include its CSS zoom/pan. */
export interface CaptionRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface CaptionLayoutInput {
  video: CaptionRect;
  viewport: CaptionRect;
  controls?: CaptionRect | null;
  mediaWidth: number;
  mediaHeight: number;
  fit: "contain" | "cover" | "fill";
  position: number;
  fontScale: number;
  zoom: number;
  text: string;
}

export interface CaptionLayout {
  line: number;
  lineAlign: "start" | "end";
  position: number;
  size: number;
  /** CSS pixels before the video's transform and the user's font scale. */
  fontSize: number;
}

const clamp = (value: number, low: number, high: number) =>
  Math.min(high, Math.max(low, value));
const valid = (r: CaptionRect) =>
  [r.left, r.top, r.width, r.height].every(Number.isFinite) && r.width > 0 && r.height > 0;
function intersection(a: CaptionRect, b: CaptionRect): CaptionRect {
  const left = Math.max(a.left, b.left);
  const top = Math.max(a.top, b.top);
  return {
    left, top,
    width: Math.min(a.left + a.width, b.left + b.width) - left,
    height: Math.min(a.top + a.height, b.top + b.height) - top,
  };
}

/**
 * Positions default horizontal cues, not authored line/vertical/region layouts.
 * Native cue boxes are private to the browser. End anchoring protects their
 * bottom edge; wrapping height is a conservative estimate, not a measured box.
 */
export function captionLayout(input: CaptionLayoutInput): CaptionLayout | null {
  const { video, viewport } = input;
  if (!valid(video) || !valid(viewport) ||
      !Number.isFinite(input.mediaWidth) || input.mediaWidth <= 0 ||
      !Number.isFinite(input.mediaHeight) || input.mediaHeight <= 0) return null;
  let picture = video;
  if (input.fit === "contain") {
    const scale = Math.min(video.width / input.mediaWidth, video.height / input.mediaHeight);
    const width = input.mediaWidth * scale;
    const height = input.mediaHeight * scale;
    picture = {
      left: video.left + (video.width - width) / 2,
      top: video.top + (video.height - height) / 2,
      width, height,
    };
  }
  // Cover crops inside the element; fill stretches to it. Both have the same
  // visible caption viewport, unlike contain's letterboxed picture.
  const visible = intersection(intersection(picture, video), viewport);
  if (!valid(visible)) return null;
  const gap = 8;
  let bottom = visible.top + visible.height - gap;
  const controls = input.controls;
  if (controls != null && valid(controls) &&
      controls.left < visible.left + visible.width &&
      controls.left + controls.width > visible.left &&
      controls.top < visible.top + visible.height &&
      controls.top + controls.height > visible.top) {
    bottom = Math.min(bottom, controls.top - gap);
  }
  const top = visible.top + gap;
  const width = visible.width - 2 * gap;
  if (bottom <= top || width <= 0) return null;
  const zoom = Number.isFinite(input.zoom) && input.zoom > 0 ? input.zoom : 1;
  const fontScale = Number.isFinite(input.fontScale) && input.fontScale > 0 ? input.fontScale : 1;
  const baseFont = clamp(visible.height * 0.055, 16, 32);
  const font = baseFont * fontScale;
  // Include explicit newlines and likely wrapping at large appearance sizes.
  // This does not parse or modify the actual cue's markup or timing.
  const charsPerLine = Math.max(1, Math.floor(width / (font * 0.6)));
  const lines = input.text.slice(0, 16_384).replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<[^>]*>/g, "").split("\n")
    .reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / charsPerLine)), 0);
  const height = Math.min(bottom - top, lines * font * 1.3);
  const preference = Number.isFinite(input.position) ? clamp(input.position, 10, 95) : 90;
  const end = preference >= 50;
  const desired = visible.top + visible.height * preference / 100;
  const anchor = end
    ? clamp(desired, top + height, bottom)
    : clamp(desired, top, bottom - height);
  return {
    line: clamp((anchor - video.top) / video.height * 100, 0, 100),
    lineAlign: end ? "end" : "start",
    position: clamp((visible.left + visible.width / 2 - video.left) / video.width * 100, 0, 100),
    size: clamp(width / video.width * 100, 0, 100),
    fontSize: baseFont / zoom,
  };
}

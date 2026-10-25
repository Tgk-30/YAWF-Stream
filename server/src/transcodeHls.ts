export const TRANSCODE_SUBTITLE_PLAYLIST_PATTERN = "%v_subtitles.m3u8";

const TRANSCODE_ASSET =
  /^(?:(?:1080p|720p|480p|360p)\.m3u8|(?:1080p|720p|480p|360p)_seg_\d{5}\.ts|seg_\d{5}\.ts|(?:1080p|720p|480p|360p)_subtitles\.m3u8|(?:1080p|720p|480p|360p)\d{1,5}\.vtt)$/;

const TRANSCODE_ASSET_LINE =
  /^(?!#)((?:1080p|720p|480p|360p)\.m3u8|(?:1080p|720p|480p|360p)_seg_\d{5}\.ts|seg_\d{5}\.ts|(?:1080p|720p|480p|360p)_subtitles\.m3u8|(?:1080p|720p|480p|360p)\d{1,5}\.vtt)$/gm;

export function isTranscodeAssetName(asset: string): boolean {
  return TRANSCODE_ASSET.test(asset);
}

/** Bind every local HLS reference to the exact output generation. FFmpeg's
 * subtitle muxer writes a proper WebVTT media playlist but omits the EVENT
 * declaration, so add it when serving a growing media playlist. */
export function rewriteTranscodeManifest(
  manifest: string,
  generation?: string,
): string {
  const suffix = generation == null
    ? ""
    : `?generation=${encodeURIComponent(generation)}`;
  let rewritten = manifest
    .replace(
      TRANSCODE_ASSET_LINE,
      (_line, asset: string) => `${asset}${suffix}`,
    )
    .replace(
      /(URI=")((?:1080p|720p|480p|360p)_subtitles\.m3u8)(")/g,
      (_line, prefix: string, asset: string, quote: string) =>
        `${prefix}${asset}${suffix}${quote}`,
    );
  if (
    rewritten.includes("#EXTINF:") &&
    !rewritten.includes("#EXT-X-PLAYLIST-TYPE:")
  ) {
    rewritten = rewritten.replace(
      /^#EXTM3U$/m,
      "#EXTM3U\n#EXT-X-PLAYLIST-TYPE:EVENT",
    );
  }
  if (
    rewritten.includes("#EXTINF:") &&
    !rewritten.includes("#EXT-X-START:")
  ) {
    // Start growing EVENT playlists at their first segment rather than at the
    // live edge. This applies to both video and its aligned WebVTT rendition.
    rewritten = rewritten.replace(
      /^#EXTM3U$/m,
      "#EXTM3U\n#EXT-X-START:TIME-OFFSET=0,PRECISE=YES",
    );
  }
  return rewritten;
}

function parseWebVttTimestamp(value: string): number | null {
  const parts = value.split(":");
  if (parts.length !== 2 && parts.length !== 3) return null;
  const hours = parts.length === 3 ? Number(parts[0]) : 0;
  const minutes = Number(parts.at(-2));
  const seconds = Number(parts.at(-1));
  if (
    !Number.isInteger(hours) ||
    !Number.isInteger(minutes) ||
    !Number.isFinite(seconds) ||
    hours < 0 ||
    minutes < 0 ||
    minutes >= 60 ||
    seconds < 0 ||
    seconds >= 60
  ) {
    return null;
  }
  const milliseconds = Math.round((hours * 3600 + minutes * 60 + seconds) * 1000);
  return Number.isSafeInteger(milliseconds) ? milliseconds : null;
}

/** Input copyts and the HLS/inner TS muxer options preserve one output clock.
 * Bind WebVTT zero to MPEG-TS zero, not the first VIDEO PTS or requested seek.
 * Validate without changing any generated cue bytes, including expired cues:
 * the client maps and filters them against its actual media init timestamp. */
export function rewriteGeneratedWebVttForTimeline(
  webVtt: string,
): string {
  const signature = /^WEBVTT(\r\n|\n|\r|$)/.exec(webVtt);
  const normalized = webVtt.replace(/\r\n?/g, "\n");
  const blocks = normalized.split(/\n{2,}/);
  const header = blocks.shift();
  if (signature == null || header == null || header.includes("-->")) {
    throw new Error("Generated subtitle segment is not WebVTT.");
  }
  if (/^[ \t]*X-TIMESTAMP-MAP\b/im.test(header)) {
    throw new Error("Generated subtitle segment already has a timestamp map.");
  }
  const timing = /^((?:\d{2,}:)?\d{2}:\d{2}\.\d{3})[ \t]+-->[ \t]+((?:\d{2,}:)?\d{2}:\d{2}\.\d{3})(?:[ \t].*)?$/;
  for (const block of blocks) {
    if (block.trim().length === 0) continue;
    const lines = block.split("\n");
    if (/^(?:NOTE(?:[ \t]|$)|STYLE$|REGION$)/.test(lines[0]!)) continue;
    // A timing line follows at most one cue identifier. Arrows in cue payload
    // or NOTE text are not timing lines and must remain byte-identical.
    const timingIndex = lines[0]!.includes("-->") ? 0 : 1;
    const match = timing.exec(lines[timingIndex] ?? "");
    if (match == null) {
      throw new Error("Generated subtitle cue has an unsupported timestamp.");
    }
    const start = parseWebVttTimestamp(match[1]!);
    const end = parseWebVttTimestamp(match[2]!);
    if (start == null || end == null || end < start) {
      throw new Error("Generated subtitle cue has an invalid timestamp.");
    }
  }
  const newline = signature[1] || "\n";
  const tail = webVtt.slice(signature[0].length);
  return `WEBVTT${newline}X-TIMESTAMP-MAP=LOCAL:00:00.000,MPEGTS:0${newline}${tail || newline}`;
}

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

/** Parse only the EVENT format produced by our fixed-rendition muxer. A
 * published URI follows a closed segment; a trailing EXTINF is not one. */
export function parsePublishedTranscodeSnapshot(
  manifest: string,
  quality: "1080p" | "720p" | "480p" | "360p",
): { frontier: number; target: number; endlist: boolean; segments: string[] } | null {
  if (Buffer.byteLength(manifest) > 1_048_576 || !manifest.endsWith("\n")) return null;
  const lines = manifest.split(/\r?\n/);
  if (lines.shift() !== "#EXTM3U") return null;
  let target: number | null = null;
  let sequence = false;
  let version = false;
  let playlistType = false;
  let pending: number | null = null;
  let frontier = 0;
  let endlist = false;
  const segments: string[] = [];
  for (const line of lines) {
    if (!line) continue;
    if (endlist) return null;
    if (pending != null) {
      const expected = `${quality}_seg_${String(segments.length).padStart(5, "0")}.ts`;
      if (line !== expected || segments.length >= 15_000) return null;
      frontier += pending;
      if (!Number.isFinite(frontier) || frontier > 604_800) return null;
      segments.push(line);
      pending = null;
    } else if (/^#EXT-X-VERSION:[1-9]\d*$/.test(line) && !version && segments.length === 0) {
      version = true;
    } else if (/^#EXT-X-TARGETDURATION:[1-9]\d*$/.test(line) && target == null && segments.length === 0) {
      target = Number(line.slice(22));
      if (!Number.isSafeInteger(target) || target > 120) return null;
    } else if (line === "#EXT-X-MEDIA-SEQUENCE:0" && !sequence && segments.length === 0) {
      sequence = true;
    } else if (line === "#EXT-X-PLAYLIST-TYPE:EVENT" && !playlistType && segments.length === 0) {
      playlistType = true;
    } else if (/^#EXTINF:(?:\d+)(?:\.\d+)?,[ \t]*$/.test(line) && target != null && sequence && playlistType) {
      pending = Number(line.slice(8).split(",")[0]);
      if (!Number.isFinite(pending) || pending <= 0 || pending > target + 0.5) return null;
    } else if (line === "#EXT-X-ENDLIST" && segments.length > 0) {
      endlist = true;
    } else {
      return null;
    }
  }
  return pending == null && target != null && sequence && playlistType && segments.length > 0
    ? { frontier, target, endlist, segments } : null;
}

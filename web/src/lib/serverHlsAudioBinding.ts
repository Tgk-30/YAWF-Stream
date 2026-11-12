import { serverHlsLeaseTarget, type ServerTranscodeQuality } from "./serverApi";

/** Attestation from the existing current-master GET, never a renderer track ID. */
export type ServerHlsAudioBinding = Readonly<{
  owner: string; identity: object; url: string; quality: ServerTranscodeQuality;
  start: number; target: string; generation: string; index: number;
}>;
type Context = { owner: string; identity: object; url: string; quality: ServerTranscodeQuality | null; start: number; target: string | null };

export function bindServerHlsAudio(
  context: Omit<Context, "target">, manifest: string, headers: Headers,
): ServerHlsAudioBinding | null {
  if (context.quality == null || context.quality === "auto" || !Number.isFinite(context.start) || context.start < 0) return null;
  // Do not require a published frontier here. This is audio identity, not
  // next-generation load-lead admission, and never authorizes a media switch.
  if (manifest.length > 65_536) return null;
  const lines = manifest.split(/\r?\n/);
  const streams = lines.filter(line => line.startsWith("#EXT-X-STREAM-INF:"));
  const children = lines.filter(line => line !== "" && !line.startsWith("#"));
  const stream = streams[0];
  const codecs = stream?.match(/(?:[:,])CODECS="([^"\r\n]+)"(?:,|$)/g);
  if (lines[0] !== "#EXTM3U" || streams.length !== 1 || children.length !== 1 ||
    lines[lines.indexOf(children[0]) - 1] !== stream ||
    lines.some(line => /^#EXT-X-MEDIA:/.test(line) || /(?:[:,])\s*URI\s*=/.test(line)) || /(?:[:,])\s*AUDIO\s*=/.test(stream) ||
    stream.match(/\bCODECS\s*=/g)?.length !== 1 || codecs?.length !== 1 || !/(?:^|,)mp4a\.40\.[0-9]+(?:,|$)/.test(codecs[0].split('"')[1])) return null;
  let query: URLSearchParams;
  try { query = new URL(context.url).searchParams; } catch { return null; }
  const generation = children[0].match(new RegExp(`^${context.quality}\\.m3u8\\?generation=(transcode-[A-Za-z0-9_-]{1,100})$`))?.[1];
  const audio = headers.get("x-yawf-transcode-audio");
  const target = serverHlsLeaseTarget(context.url, manifest);
  if (target == null || generation == null ||
    query.getAll("quality").length !== 1 || query.get("quality") !== context.quality ||
    query.getAll("start").length > 1 || (query.get("start") ?? "0") !== String(context.start) ||
    query.getAll("audio").length > 1 || (query.has("audio") && query.get("audio") !== audio) ||
    headers.get("x-yawf-transcode-quality") !== context.quality ||
    headers.get("x-yawf-transcode-start") !== String(context.start) ||
    !/^(?:0|[1-9]|[12][0-9]|3[01])$/.test(audio ?? "") ||
    (headers.has("x-yawf-hls-snapshot-generation") && headers.get("x-yawf-hls-snapshot-generation") !== generation)) return null;
  return Object.freeze({ ...context, quality: context.quality, target, generation, index: Number(audio) });
}

/** Narrow fallback for a single enabled native track with unavailable semantics. */
export function boundServerHlsAudioIndex(
  binding: ServerHlsAudioBinding | null, context: Context,
  inventory: { owner: string; tracks: readonly { index: number }[] },
  native: readonly { enabled?: boolean; language?: string | null; label?: string | null }[],
): number | null {
  if (binding == null || binding.owner !== context.owner || binding.identity !== context.identity ||
    binding.url !== context.url || binding.quality !== context.quality || binding.start !== context.start ||
    binding.target !== context.target || inventory.owner !== context.owner ||
    !Number.isInteger(binding.index) || binding.index < 0 || binding.index >= 32 ||
    inventory.tracks.filter(track => track.index === binding.index).length !== 1 ||
    native.length !== 1 || native[0].enabled !== true) return null;
  let generation: string | null;
  try { generation = new URL(binding.target).searchParams.get("generation"); } catch { return null; }
  if (generation !== binding.generation) return null;
  const language = native[0].language?.trim().toLowerCase() ?? "";
  const label = native[0].label?.trim().toLowerCase() ?? "";
  if ((language !== "" && language !== "und") || (label !== "" && !/^audio(?: track)? \d+$/.test(label))) return null;
  return binding.index;
}

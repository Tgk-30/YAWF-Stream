/** @typedef {{kind: 'ffmpeg', stage: 'mp4-generation'|'static-hls-generation'|'long-mp4-generation'|'media-output-check', label: string, args: string[]} | {kind: 'probe', stage: 'media-probe'|'long-media-probe'} | {kind: 'layout'|'mkv-verify', stage: 'media-output-check'}} FixtureMediaStep */

/** @param {{foregroundLong: boolean, videoFilter: string, moviePath: string, segmentPattern: string, playlistPath: string, sourceMkv?: boolean, mkvPath?: string}} options @returns {FixtureMediaStep[]} */
export function buildFixtureMediaPlan({ foregroundLong, videoFilter, moviePath, segmentPattern, playlistPath, sourceMkv = false, mkvPath }) {
  /** @param {36|600} duration @param {boolean} replace @returns {Extract<FixtureMediaStep, {kind: 'ffmpeg'}>} */
  const mp4 = (duration, replace) => ({
    kind: 'ffmpeg', stage: replace ? 'long-mp4-generation' : 'mp4-generation',
    label: replace ? 'Synthetic long MP4 generation' : 'Synthetic MP4 generation',
    args: [
      ...(replace ? ['-y'] : []),
      '-f', 'lavfi', '-i', `testsrc2=size=1280x720:rate=30:duration=${duration}`,
      '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000:duration=${duration}`,
      '-vf', videoFilter, '-t', String(duration),
      ...(replace ? ['-b:v', '700k', '-maxrate', '900k', '-bufsize', '1400k'] : []),
      '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
      '-g', '90', '-keyint_min', '90', '-sc_threshold', '0',
      '-force_key_frames', 'expr:gte(t,n_forced*3)', '-c:a', 'aac', '-b:a', '128k',
      '-movflags', '+faststart', moviePath,
    ],
  });
  /** @type {FixtureMediaStep[]} */
  const plan = [
    mp4(36, false),
    { kind: 'ffmpeg', stage: 'static-hls-generation', label: 'Synthetic HLS generation', args: [
      '-i', moviePath, '-map', '0:v:0', '-map', '0:a:0', '-c', 'copy', '-f', 'hls',
      '-hls_time', '3', '-hls_list_size', '0', '-hls_playlist_type', 'vod',
      '-hls_flags', 'independent_segments', '-hls_segment_type', 'mpegts', '-start_number', '0',
      '-hls_segment_filename', segmentPattern, playlistPath,
    ] },
    { kind: 'probe', stage: 'media-probe' },
    { kind: 'layout', stage: 'media-output-check' },
  ];
  if (foregroundLong) {
    plan.push(mp4(600, true));
    // Only the optional two-container case needs its own per-file disk ceiling.
    if (sourceMkv) {
      const replacement = plan[plan.length - 1];
      if (replacement.kind !== 'ffmpeg') throw new Error('Invalid long media plan');
      replacement.args.splice(replacement.args.length - 1, 0, '-fs', String(512 * 1024 * 1024));
    }
    plan.push({ kind: 'probe', stage: 'long-media-probe' });
  }
  if (sourceMkv) {
    if (!foregroundLong || !mkvPath || mkvPath === moviePath) throw new Error('Invalid MKV fixture plan');
    plan.push({ kind: 'ffmpeg', stage: 'media-output-check', label: 'Synthetic MKV stream-copy remux', args: [
      '-i', moviePath, '-map', '0:v:0', '-map', '0:a:0', '-c', 'copy', '-fs', String(512 * 1024 * 1024), '-f', 'matroska', mkvPath,
    ] });
    plan.push({ kind: 'mkv-verify', stage: 'media-output-check' });
  }
  return plan;
}

export function validMkvFixtureOptions({ sourceMkv, foregroundLong, ipadForeground }) {
  return !sourceMkv || (foregroundLong === true && ipadForeground === true);
}

export function validateMkvProbe(probe, size) {
  if (!probe || !Array.isArray(probe.streams) || probe.streams.length !== 2 || !probe.format ||
      !Number.isSafeInteger(size) || size <= 0 || size > 512 * 1024 * 1024 ||
      !String(probe.format.format_name || '').split(',').includes('matroska') ||
      !Number.isFinite(Number(probe.format.duration)) || Number(probe.format.duration) < 599 || Number(probe.format.duration) > 601) return false;
  const video = probe.streams.filter(s => s.codec_type === 'video');
  const audio = probe.streams.filter(s => s.codec_type === 'audio');
  return video.length === 1 && audio.length === 1 && video[0].codec_name === 'h264' &&
    video[0].pix_fmt === 'yuv420p' && video[0].width === 1280 && video[0].height === 720 &&
    video[0].r_frame_rate === '30/1' && audio[0].codec_name === 'aac' && audio[0].sample_rate === '48000';
}

export function parseStreamHashes(output) {
  if (typeof output !== 'string' || output.length > 1024) return null;
  const lines = output.trim().split(/\r?\n/);
  if (lines.length !== 2) return null;
  const match = lines.map(line => /^(\d+),([va]),SHA256=([a-f0-9]{64})$/i.exec(line));
  if (!match[0] || !match[1] || match[0][1] !== '0' || match[0][2] !== 'v' || match[1][1] !== '1' || match[1][2] !== 'a') return null;
  return [match[0][3].toLowerCase(), match[1][3].toLowerCase()];
}

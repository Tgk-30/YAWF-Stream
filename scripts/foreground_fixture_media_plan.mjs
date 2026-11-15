/** @typedef {{kind: 'ffmpeg', stage: 'mp4-generation'|'static-hls-generation'|'long-mp4-generation', label: string, args: string[]} | {kind: 'probe', stage: 'media-probe'|'long-media-probe'} | {kind: 'layout', stage: 'media-output-check'}} FixtureMediaStep */

/** @param {{foregroundLong: boolean, videoFilter: string, moviePath: string, segmentPattern: string, playlistPath: string}} options @returns {FixtureMediaStep[]} */
export function buildFixtureMediaPlan({ foregroundLong, videoFilter, moviePath, segmentPattern, playlistPath }) {
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
    plan.push({ kind: 'probe', stage: 'long-media-probe' });
  }
  return plan;
}

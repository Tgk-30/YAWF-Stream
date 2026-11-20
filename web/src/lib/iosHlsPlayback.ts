export type IosHlsPlaybackMode = "automatic" | "native" | "compatibility";
export type IosHlsSourceMode = Exclude<IosHlsPlaybackMode, "automatic">;

export const IOS_HLS_COMPATIBILITY_MIME =
  'video/mp4; codecs="avc1.64001e,mp4a.40.2"';

type MediaSourceConstructorLike = {
  new (): MediaSource;
  isTypeSupported?: (mime: string) => boolean;
};

export type IosHlsCapabilityScope = {
  MediaSource?: MediaSourceConstructorLike;
  ManagedMediaSource?: unknown;
  SourceBuffer?: { prototype?: Partial<SourceBuffer> };
};

export function normalizeIosHlsPlaybackMode(value: unknown): IosHlsPlaybackMode {
  if (value == null || value === "automatic") return "automatic";
  return value === "compatibility" ? "compatibility" : "native";
}

export function iosHlsModeForSource(
  mode: IosHlsPlaybackMode,
  fixedServerRendition: boolean,
): IosHlsSourceMode {
  if (mode !== "automatic") return mode;
  return fixedServerRendition ? "compatibility" : "native";
}

/** Static capability admission only. Actual construction, attachment and decode
 * remain owned by hls.js after the player revalidates this immediately before
 * creating its instance. */
export function supportsStandardIosHlsMse(
  scope: IosHlsCapabilityScope = globalThis,
): boolean {
  const StandardMediaSource = scope.MediaSource;
  const sourceBuffer = scope.SourceBuffer?.prototype;
  if (
    typeof StandardMediaSource !== "function" ||
    StandardMediaSource === scope.ManagedMediaSource ||
    typeof StandardMediaSource.isTypeSupported !== "function" ||
    typeof sourceBuffer?.appendBuffer !== "function" ||
    typeof sourceBuffer?.remove !== "function"
  ) {
    return false;
  }
  try {
    return StandardMediaSource.isTypeSupported(IOS_HLS_COMPATIBILITY_MIME) === true;
  } catch {
    return false;
  }
}

export function iosHlsPlaybackRoute(options: {
  mode: IosHlsSourceMode;
  nativePlayable: boolean;
  scope?: IosHlsCapabilityScope;
}): "native" | "compatibility" | "unsupported" {
  if (
    options.mode === "compatibility" &&
    supportsStandardIosHlsMse(options.scope)
  ) {
    return "compatibility";
  }
  return options.nativePlayable ? "native" : "unsupported";
}

export interface AndroidTVPlaybackRequest {
  url: string;
  title: string;
  subtitle: string | null;
  startPositionSeconds: number;
  authorization: string | null;
  audioLanguage: string | null;
  subtitleLanguage: string | null;
  subtitlesEnabled: boolean;
}

export interface AndroidTVPlaybackProgress {
  positionSeconds: number;
  durationSeconds: number | null;
}

interface AndroidTVBridge {
  play(payload: string): void;
  stop(): void;
}

declare global {
  interface Window {
    YawfAndroidTV?: AndroidTVBridge;
  }
}

export function hasAndroidTVBridge(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.YawfAndroidTV?.play === "function" &&
    typeof window.YawfAndroidTV?.stop === "function"
  );
}

export function startAndroidTVPlayback(
  request: AndroidTVPlaybackRequest,
): boolean {
  if (!hasAndroidTVBridge()) return false;
  try {
    window.YawfAndroidTV!.play(JSON.stringify(request));
    return true;
  } catch {
    return false;
  }
}

export function stopAndroidTVPlayback(): void {
  try {
    if (typeof window !== "undefined") window.YawfAndroidTV?.stop();
  } catch {
    // The native view may already be gone during Activity teardown.
  }
}

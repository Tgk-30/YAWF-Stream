import { useEffect } from "react";
import {
  fetchTVRemoteSession,
  updateTVRemoteState,
  type TVRemoteCommand,
} from "../../lib/serverApi";
import { isTVMode } from "../../lib/tvMode";
import {
  acknowledgeRemoteSequence,
  acknowledgedRemoteSequence,
  setTVRemoteSession,
  useTVRemoteSession,
} from "../../lib/tvRemoteSession";

function finiteDuration(video: HTMLVideoElement): number | null {
  return Number.isFinite(video.duration) && video.duration >= 0
    ? video.duration
    : null;
}

function seek(video: HTMLVideoElement, position: number): void {
  const duration = finiteDuration(video);
  video.currentTime =
    duration == null
      ? Math.max(0, position)
      : Math.min(duration, Math.max(0, position));
}

async function applyCommand(
  command: TVRemoteCommand,
  video: HTMLVideoElement,
  onClose: () => void,
  onNext?: () => void,
): Promise<void> {
  switch (command.type) {
    case "play":
      await video.play().catch(() => {});
      return;
    case "pause":
      video.pause();
      return;
    case "seek-relative":
      seek(video, video.currentTime + Number(command.value ?? 0));
      return;
    case "seek-absolute":
      seek(video, Number(command.value ?? 0));
      return;
    case "volume":
      video.volume = Math.min(1, Math.max(0, Number(command.value ?? 1)));
      if (video.volume > 0) video.muted = false;
      return;
    case "mute":
      video.muted = command.value === true;
      return;
    case "fullscreen":
      if (document.fullscreenElement != null) {
        await document.exitFullscreen().catch(() => {});
      } else {
        await video.closest<HTMLElement>(".player")?.requestFullscreen?.().catch(() => {});
      }
      return;
    case "next":
      onNext?.();
      return;
    case "close":
      onClose();
      return;
  }
}

export function useTVRemotePlayback(input: {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  title: string;
  subtitle?: string | null;
  onClose: () => void;
  onNext?: () => void;
}): void {
  const session = useTVRemoteSession();

  useEffect(() => {
    if (!isTVMode() || session == null) return;
    let stopped = false;
    let timer: number | undefined;

    const poll = async () => {
      try {
        const snapshot = await fetchTVRemoteSession(
          session.id,
          acknowledgedRemoteSequence(session.id),
        );
        for (const command of snapshot.commands) {
          const video = input.videoRef.current;
          if (video == null) break;
          // Mark before an action that can unmount this player, so a later
          // player does not replay a stale Next or Close command.
          acknowledgeRemoteSequence(session.id, command.sequence);
          await applyCommand(
            command,
            video,
            input.onClose,
            input.onNext,
          );
        }
      } catch (reason) {
        if (
          reason instanceof Error &&
          "status" in reason &&
          (reason as Error & { status: number }).status === 404
        ) {
          setTVRemoteSession(null);
          return;
        }
      }
      if (!stopped) timer = window.setTimeout(poll, 650);
    };

    void poll();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [input.onClose, input.onNext, input.videoRef, session]);

  useEffect(() => {
    if (!isTVMode() || session == null) return;
    let stopped = false;
    const report = () => {
      const video = input.videoRef.current;
      if (video == null || stopped) return;
      void updateTVRemoteState(session.id, {
        title: input.title,
        subtitle: input.subtitle?.trim() || null,
        playing: !video.paused && !video.ended,
        positionSeconds: Number.isFinite(video.currentTime)
          ? Math.max(0, video.currentTime)
          : 0,
        durationSeconds: finiteDuration(video),
        volume: video.volume,
        muted: video.muted,
      }).catch(() => {});
    };
    report();
    const timer = window.setInterval(report, 1_500);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [input.subtitle, input.title, input.videoRef, session]);
}

// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

const closeLocalFilePlayer = vi.hoisted(() => vi.fn());
const store = vi.hoisted(() => ({
  localFilePlayer: {
    path: "/Users/alice/Movies/Rick and Morty S09E08.mkv",
    title: "Rick and Morty S09E08 - The Last Temptation of Jerry",
  } as { path: string; title: string } | null,
  closeLocalFilePlayer,
  settings: {
    preferredExternalPlayer: "",
    builtInPlayer: true,
    defaultAudioLanguage: "ja",
    defaultSubtitleLanguage: "en",
    defaultSubtitleBehavior: "preferred",
    defaultPlaybackSpeed: 1.25,
    defaultVolume: 40,
    rememberPerTitleTrackChoices: false,
  },
}));

vi.mock("../store/AppStore", () => ({
  useAppStore: () => store,
}));
vi.mock("./Spinner", () => ({
  Spinner: () => <div>Loading player</div>,
}));
vi.mock("./VideoPlayer", () => ({
  VideoPlayer: (props: {
    url: string;
    title: string;
    sourceFileName: string;
    engine: string;
    startPositionSeconds: number;
    playerPreferences: {
      defaultAudioLanguage: string;
      defaultSubtitleLanguage: string;
      defaultSubtitleBehavior: string;
      defaultPlaybackSpeed: number;
      defaultVolume: number;
      rememberPerTitleTrackChoices: boolean;
    };
    onClose: () => void;
  }) => (
    <button
      type="button"
      data-testid="local-native-player"
      data-url={props.url}
      data-title={props.title}
      data-source-file={props.sourceFileName}
      data-engine={props.engine}
      data-start={props.startPositionSeconds}
      data-default-audio-language={props.playerPreferences.defaultAudioLanguage}
      data-default-subtitle-language={props.playerPreferences.defaultSubtitleLanguage}
      data-default-subtitle-behavior={props.playerPreferences.defaultSubtitleBehavior}
      data-default-playback-speed={props.playerPreferences.defaultPlaybackSpeed}
      data-default-volume={props.playerPreferences.defaultVolume}
      data-remember-per-title-track-choices={String(
        props.playerPreferences.rememberPerTitleTrackChoices,
      )}
      onClick={props.onClose}
    />
  ),
}));

import { LocalPlayerHost } from "./LocalPlayerHost";

describe("LocalPlayerHost", () => {
  it("passes the raw local path to the native-mpv player and starts fresh", async () => {
    render(<LocalPlayerHost />);

    const player = await screen.findByTestId("local-native-player");
    expect(player).toHaveAttribute("data-url", store.localFilePlayer!.path);
    expect(player).toHaveAttribute("data-engine", "native-mpv");
    expect(player).toHaveAttribute("data-start", "0");
    expect(player).toHaveAttribute("data-source-file", "Rick and Morty S09E08.mkv");
    expect(player).toHaveAttribute("data-default-audio-language", "ja");
    expect(player).toHaveAttribute("data-default-subtitle-language", "en");
    expect(player).toHaveAttribute("data-default-subtitle-behavior", "preferred");
    expect(player).toHaveAttribute("data-default-playback-speed", "1.25");
    expect(player).toHaveAttribute("data-default-volume", "40");
    expect(player).toHaveAttribute("data-remember-per-title-track-choices", "false");

    fireEvent.click(player);
    expect(closeLocalFilePlayer).toHaveBeenCalledOnce();
  });

  it("renders nothing when no local file is selected", () => {
    store.localFilePlayer = null;
    render(<LocalPlayerHost />);

    expect(screen.queryByTestId("local-native-player")).not.toBeInTheDocument();
  });
});

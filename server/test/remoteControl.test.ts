import { describe, expect, it } from "vitest";
import {
  REMOTE_COMMAND_LIMIT,
  REMOTE_PAIRING_TTL_MS,
  RemoteControlRegistry,
} from "../src/remoteControl.js";

describe("RemoteControlRegistry", () => {
  it("pairs a single controller and keeps the token out of viewer snapshots", () => {
    let now = 1_000;
    const registry = new RemoteControlRegistry(() => now);
    const viewer = registry.create("profile-a");

    expect(viewer.pairingCode).toMatch(/^\d{6}$/);
    const controller = registry.pair(viewer.pairingCode, "Brendan's phone");
    expect(controller?.controllerToken).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(registry.pair(viewer.pairingCode, "Other phone")).toBeNull();

    const snapshot = registry.viewerSnapshot(viewer.id, "profile-a");
    expect(snapshot).toMatchObject({
      paired: true,
      controllerName: "Brendan's phone",
    });
    expect(snapshot).not.toHaveProperty("controllerToken");
    expect(registry.viewerSnapshot(viewer.id, "profile-b")).toBeNull();

    now += REMOTE_PAIRING_TTL_MS + 1;
    expect(registry.controllerSnapshot(viewer.id, controller!.controllerToken)).not.toBeNull();
  });

  it("authenticates controller commands and bounds the queue", () => {
    const registry = new RemoteControlRegistry(() => 2_000);
    const viewer = registry.create("profile-a");
    const controller = registry.pair(viewer.pairingCode, null)!;

    expect(
      registry.enqueue(viewer.id, "wrong", { type: "play" }),
    ).toBeNull();
    for (let index = 0; index < REMOTE_COMMAND_LIMIT + 5; index += 1) {
      registry.enqueue(viewer.id, controller.controllerToken, {
        type: "seek-absolute",
        value: index,
      });
    }

    const commands = registry.viewerSnapshot(viewer.id, "profile-a")!.commands;
    expect(commands).toHaveLength(REMOTE_COMMAND_LIMIT);
    expect(commands[0]?.sequence).toBe(6);
    expect(commands.at(-1)?.sequence).toBe(REMOTE_COMMAND_LIMIT + 5);
  });

  it("expires an unused pairing code", () => {
    let now = 3_000;
    const registry = new RemoteControlRegistry(() => now);
    const viewer = registry.create("profile-a");
    now += REMOTE_PAIRING_TTL_MS + 1;
    expect(registry.pair(viewer.pairingCode, null)).toBeNull();
  });

  it("updates state only from the viewer profile", () => {
    const registry = new RemoteControlRegistry(() => 4_000);
    const viewer = registry.create("profile-a");
    const state = {
      title: "Arrival",
      subtitle: null,
      playing: true,
      positionSeconds: 42,
      durationSeconds: 120,
      volume: 0.75,
      muted: false,
    };

    expect(registry.updateState(viewer.id, "profile-b", state)).toBeNull();
    expect(registry.updateState(viewer.id, "profile-a", state)).toMatchObject({
      ...state,
      updatedAt: new Date(4_000).toISOString(),
    });
  });
});

// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  consumeInstallPrompt,
  getInstallPrompt,
  initInstallPromptCapture,
  subscribeInstallPrompt,
} from "./installPrompt";

describe("installPrompt capture", () => {
  beforeEach(() => {
    consumeInstallPrompt();
  });

  it("captures beforeinstallprompt, shares it with subscribers, and clears on appinstalled", () => {
    const updates: Array<Event | null> = [];
    const unsubscribe = subscribeInstallPrompt((value) => {
      updates.push(value);
    });

    initInstallPromptCapture();

    const prompt = new Event("beforeinstallprompt") as Event & {
      readonly platforms: readonly string[];
      readonly userChoice: Promise<{ outcome: string }>;
      prompt: () => Promise<void>;
      preventDefault: () => void;
    };

    const preventDefault = vi.spyOn(prompt, "preventDefault");
    window.dispatchEvent(prompt);

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(getInstallPrompt()).toBe(prompt);
    expect(updates).toContain(prompt);

    window.dispatchEvent(new Event("appinstalled"));
    expect(getInstallPrompt()).toBeNull();
    expect(updates.at(-1)).toBeNull();

    unsubscribe();
  });

  it("supports unsubscribe for install prompt listeners", () => {
    const updates = vi.fn();
    const unsubscribe = subscribeInstallPrompt(updates);
    unsubscribe();

    const prompt = new Event("beforeinstallprompt");
    initInstallPromptCapture();
    window.dispatchEvent(prompt);

    expect(updates).not.toHaveBeenCalled();
  });
});

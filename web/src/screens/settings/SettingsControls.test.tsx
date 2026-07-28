// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { Field, SegmentedControl } from "./SettingsControls";
import { InfoTip } from "../../components/InfoTip";

vi.mock("../../components/Icon", () => ({
  Icon: () => null,
}));

vi.mock("../../components/InfoTip", () => ({
  InfoTip: ({ children, label }: { children: React.ReactNode; label?: string }) =>
    label ? <div>{label}: {children}</div> : <>{children}</>,
}));

describe("Settings controls", () => {
  it("renders a help URL in Field with the default label", () => {
    render(
      <Field label="OpenSubtitles key" helpUrl="https://opensubtitles.org" helpLabel="Get a key">
        <input />
      </Field>,
    );

    const link = screen.getByRole("link", { name: /Get a key/i });
    expect(link).toHaveAttribute("href", "https://opensubtitles.org");
    expect(link).toHaveAttribute("target", "_blank");
  });

  it("clicking segmented controls emits selected value", async () => {
    const onChange = vi.fn();
    const options = [
      { value: "a", label: "A" },
      { value: "b", label: "B" },
    ];
    render(
      <SegmentedControl
        label="Mode"
        value="a"
        options={options}
        onChange={onChange}
        infoTip={<InfoTip label="about">About mode.</InfoTip>}
      />,
    );

    await screen.findByText("Mode");
    await screen.getByRole("radio", { name: "B" }).click();
    expect(onChange).toHaveBeenCalledWith("b");
  });

  it("uses the default help label when not provided", () => {
    render(
      <Field label="Trakt client ID" helpUrl="https://trakt.tv/settings/api">
        <input />
      </Field>,
    );

    const link = screen.getByRole("link", { name: /Get a key ↗/i });
    expect(link).toHaveAttribute("href", "https://trakt.tv/settings/api");
  });
});

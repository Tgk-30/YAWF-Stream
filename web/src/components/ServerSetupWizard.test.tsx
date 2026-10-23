// @vitest-environment jsdom
//
// Component coverage for the Server-Mode owner setup wizard. Verifies the step
// rail/progress, welcome → keys → access → invite → done navigation (next/back),
// skip + finish (markServerSetupComplete), the keys-step shared-credential save
// flow (empty-skip, multi-save, error surface), and the invite-step create flow
// (createServerInvite request shape, QR + copy, skip-inline). serverApi, the QR
// lib, serverMode, and serverSetup persistence are all mocked.

import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// --- mocks for every external dependency the component imports ---------------

const saveServerSharedCredential = vi.fn().mockResolvedValue(undefined);
const createServerInvite = vi
  .fn()
  .mockResolvedValue({ token: "tok_abc123" });

vi.mock("../lib/serverApi", () => ({
  saveServerSharedCredential: (input: unknown) => saveServerSharedCredential(input),
  createServerInvite: (input: unknown) => createServerInvite(input),
}));

const markServerSetupComplete = vi.fn().mockResolvedValue(undefined);
vi.mock("../lib/serverSetup", () => ({
  markServerSetupComplete: () => markServerSetupComplete(),
}));

const configuredServerURL = vi.fn<() => string | null>(() => "https://my.server");
vi.mock("../lib/serverMode", () => ({
  configuredServerURL: () => configuredServerURL(),
}));

const toDataURL = vi.fn().mockResolvedValue("data:image/png;base64,QRZZ");
vi.mock("qrcode", () => ({
  default: { toDataURL: (...args: unknown[]) => toDataURL(...args) },
}));

import { ServerSetupWizard } from "./ServerSetupWizard";

/** Advance from welcome to a named step by clicking the primary CTA chain. */
async function gotoKeys(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Get started" }));
}
async function gotoAccess(user: ReturnType<typeof userEvent.setup>) {
  await gotoKeys(user);
  await user.click(screen.getByRole("button", { name: "Save and continue" }));
}
async function gotoInvite(user: ReturnType<typeof userEvent.setup>) {
  await gotoAccess(user);
  await user.click(screen.getByRole("button", { name: "Continue" }));
}

describe("ServerSetupWizard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    saveServerSharedCredential.mockResolvedValue(undefined);
    createServerInvite.mockResolvedValue({ token: "tok_abc123" });
    markServerSetupComplete.mockResolvedValue(undefined);
    configuredServerURL.mockReturnValue("https://my.server");
    toDataURL.mockResolvedValue("data:image/png;base64,QRZZ");
  });

  it("renders the welcome step and the five-dot progress rail", () => {
    render(<ServerSetupWizard onDone={() => {}} />);
    expect(screen.getByText("Your server is live")).toBeInTheDocument();
    const rail = screen.getByRole("list", { name: "Setup progress" });
    // Welcome, API keys, Access, Invite, Finish.
    expect(within(rail).getAllByRole("listitem")).toHaveLength(5);
    expect(within(rail).getByText("Welcome")).toBeInTheDocument();
    expect(within(rail).getByText("Finish")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Get started" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Skip setup" })).toBeInTheDocument();
  });

  it("Skip setup marks complete and calls onDone", async () => {
    const user = userEvent.setup();
    const onDone = vi.fn();
    render(<ServerSetupWizard onDone={onDone} />);
    await user.click(screen.getByRole("button", { name: "Skip setup" }));
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(markServerSetupComplete).toHaveBeenCalledTimes(1);
  });

  it("Skip setup exposes a retryable completion error and ignores double activation", async () => {
    const user = userEvent.setup();
    const onDone = vi.fn();
    let rejectCompletion!: (reason: Error) => void;
    markServerSetupComplete
      .mockImplementationOnce(
        () =>
          new Promise<void>((_resolve, reject) => {
            rejectCompletion = reject;
          }),
      )
      .mockResolvedValueOnce(undefined);

    render(<ServerSetupWizard onDone={onDone} />);
    const skip = screen.getByRole("button", { name: "Skip setup" });
    await user.click(skip);

    const saving = screen.getByRole("button", { name: "Saving..." });
    expect(saving).toBeDisabled();
    await user.click(saving);
    expect(markServerSetupComplete).toHaveBeenCalledTimes(1);

    await act(async () => {
      rejectCompletion(new Error("storage unavailable"));
    });

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "We couldn't record that server setup is complete.",
    );
    expect(onDone).not.toHaveBeenCalled();

    await user.click(
      screen.getByRole("button", { name: "Retry saving setup" }),
    );
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(markServerSetupComplete).toHaveBeenCalledTimes(2);
  });

  it("Get started advances to the keys step", async () => {
    const user = userEvent.setup();
    render(<ServerSetupWizard onDone={() => {}} />);
    await gotoKeys(user);
    expect(screen.getByText("Add your API keys")).toBeInTheDocument();
    expect(screen.getByText("Debrid provider")).toBeInTheDocument();
    expect(screen.getByText("TMDB API key")).toBeInTheDocument();
  });

  it("keys step with nothing entered skips saving and advances to access", async () => {
    const user = userEvent.setup();
    render(<ServerSetupWizard onDone={() => {}} />);
    await gotoKeys(user);
    await user.click(screen.getByRole("button", { name: "Save and continue" }));
    expect(saveServerSharedCredential).not.toHaveBeenCalled();
    expect(screen.getByText("Make it reachable")).toBeInTheDocument();
  });

  it("keys step Back returns to welcome", async () => {
    const user = userEvent.setup();
    render(<ServerSetupWizard onDone={() => {}} />);
    await gotoKeys(user);
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByText("Your server is live")).toBeInTheDocument();
  });

  it("keys step saves the debrid token under the selected provider and a TMDB key", async () => {
    const user = userEvent.setup();
    render(<ServerSetupWizard onDone={() => {}} />);
    await gotoKeys(user);

    // Select TorBox as the debrid provider, type a token.
    await user.selectOptions(
      screen.getByRole("combobox", { name: /Debrid provider/ }),
      "TorBox",
    );
    await user.type(screen.getByPlaceholderText("TorBox API token"), "tb-token");
    await user.type(screen.getByPlaceholderText("TMDB v3 API key"), "tmdb-key");

    await user.click(screen.getByRole("button", { name: "Save and continue" }));

    await waitFor(() =>
      expect(saveServerSharedCredential).toHaveBeenCalledTimes(2),
    );
    // TMDB field saved first (key fields precede the debrid draft).
    expect(saveServerSharedCredential).toHaveBeenCalledWith({
      provider: "tmdb",
      label: "TMDB API key",
      value: "tmdb-key",
    });
    expect(saveServerSharedCredential).toHaveBeenCalledWith({
      provider: "torbox",
      label: "TorBox",
      value: "tb-token",
    });
    // Advanced to the access step after saving.
    expect(screen.getByText("Make it reachable")).toBeInTheDocument();
  });

  it("keys step surfaces an error and stays put when a save fails", async () => {
    const user = userEvent.setup();
    saveServerSharedCredential.mockRejectedValueOnce(new Error("boom"));
    render(<ServerSetupWizard onDone={() => {}} />);
    await gotoKeys(user);
    await user.type(
      screen.getByPlaceholderText("TorBox API token"),
      "rd-token",
    );
    await user.click(screen.getByRole("button", { name: "Save and continue" }));

    expect(
      await screen.findByText(/Couldn't save a key \(boom\)/),
    ).toBeInTheDocument();
    // Did not advance away from the keys step.
    expect(screen.getByText("Add your API keys")).toBeInTheDocument();
    // Save button re-enabled after the failure.
    expect(screen.getByRole("button", { name: "Save and continue" })).toBeEnabled();
  });

  it("access step renders the configured base URL and tunnel cards", async () => {
    const user = userEvent.setup();
    render(<ServerSetupWizard onDone={() => {}} />);
    await gotoAccess(user);
    expect(screen.getByText("Make it reachable")).toBeInTheDocument();
    expect(screen.getByText("https://my.server")).toBeInTheDocument();
    expect(screen.getByText("Tailscale")).toBeInTheDocument();
    expect(screen.getByText("Cloudflare Tunnel")).toBeInTheDocument();
  });

  it("access step falls back to 'your local network' when no URL is configured", async () => {
    const user = userEvent.setup();
    configuredServerURL.mockReturnValue(null);
    render(<ServerSetupWizard onDone={() => {}} />);
    await gotoAccess(user);
    expect(screen.getByText(/your local network/)).toBeInTheDocument();
  });

  it("access step Back returns to the keys step", async () => {
    const user = userEvent.setup();
    render(<ServerSetupWizard onDone={() => {}} />);
    await gotoAccess(user);
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByText("Add your API keys")).toBeInTheDocument();
  });

  it("invite step shows preset selector and summary before any invite exists", async () => {
    const user = userEvent.setup();
    render(<ServerSetupWizard onDone={() => {}} />);
    await gotoInvite(user);
    expect(screen.getByText("Invite your household")).toBeInTheDocument();
    expect(
      screen.getByRole("combobox", { name: /Invite preset/ }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create invite" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Skip - I'll invite people later/ }),
    ).toBeInTheDocument();
  });

  it("invite step creates an invite, builds the URL + QR, and shows Copy link", async () => {
    const user = userEvent.setup();
    render(<ServerSetupWizard onDone={() => {}} />);
    await gotoInvite(user);

    await user.click(screen.getByRole("button", { name: "Create invite" }));

    await waitFor(() =>
      expect(createServerInvite).toHaveBeenCalledWith({
        label: "Family",
        role: "member",
        simpleMode: true,
        maxUses: 5,
        expiresInSeconds: 7 * 24 * 60 * 60,
      }),
    );
    // The shareable URL uses the configured base + the returned token.
    const url = await screen.findByText("https://my.server/?invite=tok_abc123");
    expect(url).toBeInTheDocument();
    // QR rendered from the data URL the mocked qrcode lib returned.
    expect(
      await screen.findByAltText("QR code that opens the household invite link"),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy link" })).toBeInTheDocument();
  });

  it("invite step selecting the power-user preset creates a full-interface invite", async () => {
    const user = userEvent.setup();
    render(<ServerSetupWizard onDone={() => {}} />);
    await gotoInvite(user);
    await user.selectOptions(
      screen.getByRole("combobox", { name: /Invite preset/ }),
      "Power user",
    );
    await user.click(screen.getByRole("button", { name: "Create invite" }));
    await waitFor(() =>
      expect(createServerInvite).toHaveBeenCalledWith(
        expect.objectContaining({ label: "Power user", simpleMode: false }),
      ),
    );
  });

  it("invite step Copy link writes the URL to the clipboard and flips to Copied", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    render(<ServerSetupWizard onDone={() => {}} />);
    await gotoInvite(user);
    await user.click(screen.getByRole("button", { name: "Create invite" }));
    const copyBtn = await screen.findByRole("button", { name: "Copy link" });
    await user.click(copyBtn);
    expect(writeText).toHaveBeenCalledWith("https://my.server/?invite=tok_abc123");
    expect(await screen.findByRole("button", { name: "Copied" })).toBeInTheDocument();
  });

  it("invite step surfaces an error when invite creation fails", async () => {
    const user = userEvent.setup();
    createServerInvite.mockRejectedValueOnce(new Error("no invite for you"));
    render(<ServerSetupWizard onDone={() => {}} />);
    await gotoInvite(user);
    await user.click(screen.getByRole("button", { name: "Create invite" }));
    expect(await screen.findByText("no invite for you")).toBeInTheDocument();
    // Still on the create form (no Continue button yet).
    expect(screen.getByRole("button", { name: "Create invite" })).toBeInTheDocument();
  });

  it("invite step Skip-inline jumps to the done step", async () => {
    const user = userEvent.setup();
    render(<ServerSetupWizard onDone={() => {}} />);
    await gotoInvite(user);
    await user.click(
      screen.getByRole("button", { name: /Skip - I'll invite people later/ }),
    );
    expect(screen.getByText("You're all set")).toBeInTheDocument();
  });

  it("Continue after creating an invite advances to the done step", async () => {
    const user = userEvent.setup();
    render(<ServerSetupWizard onDone={() => {}} />);
    await gotoInvite(user);
    await user.click(screen.getByRole("button", { name: "Create invite" }));
    const continueBtn = await screen.findByRole("button", { name: "Continue" });
    await user.click(continueBtn);
    expect(screen.getByText("You're all set")).toBeInTheDocument();
  });

  it("done step hides Skip, lists the recap, and finishes via Open YAWF Stream", async () => {
    const user = userEvent.setup();
    const onDone = vi.fn();
    render(<ServerSetupWizard onDone={onDone} />);
    await gotoInvite(user);
    await user.click(
      screen.getByRole("button", { name: /Skip - I'll invite people later/ }),
    );
    // On the final step there is no Skip-setup affordance.
    expect(screen.queryByRole("button", { name: "Skip setup" })).toBeNull();
    expect(
      screen.getByText(/Manage profiles and invites in Settings → Server\./),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Open YAWF Stream" }));
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(markServerSetupComplete).toHaveBeenCalledTimes(1);
  });

  it("done step retries only the completion marker after persistence fails", async () => {
    const user = userEvent.setup();
    const onDone = vi.fn();
    markServerSetupComplete
      .mockRejectedValueOnce(new Error("storage unavailable"))
      .mockResolvedValueOnce(undefined);
    render(<ServerSetupWizard onDone={onDone} />);
    await gotoInvite(user);
    await user.click(
      screen.getByRole("button", { name: /Skip - I'll invite people later/ }),
    );

    const credentialWrites = saveServerSharedCredential.mock.calls.length;
    const inviteWrites = createServerInvite.mock.calls.length;
    await user.click(screen.getByRole("button", { name: "Open YAWF Stream" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "We couldn't record that server setup is complete.",
    );
    expect(onDone).not.toHaveBeenCalled();

    await user.click(
      screen.getByRole("button", { name: "Retry saving setup" }),
    );
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(markServerSetupComplete).toHaveBeenCalledTimes(2);
    expect(saveServerSharedCredential).toHaveBeenCalledTimes(credentialWrites);
    expect(createServerInvite).toHaveBeenCalledTimes(inviteWrites);
  });
});

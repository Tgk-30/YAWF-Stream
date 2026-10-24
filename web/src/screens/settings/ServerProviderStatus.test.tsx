// @vitest-environment jsdom

import { StrictMode } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  parseSavedProviderStatus,
  ServerProviderStatus,
} from "./ServerProviderStatus";

type CredentialRow = Record<string, unknown>;

function response(rows: CredentialRow[]) {
  return { credentials: rows };
}

function rows(
  selected: "profile" | "server" | "missing" = "missing",
): CredentialRow[] {
  return ["real_debrid", "all_debrid", "premiumize", "torbox"].map((provider) => {
    const scope = provider === "torbox" ? selected : "missing";
    return scope === "missing"
      ? { provider, scope: null, id: null, label: null }
      : {
          provider,
          scope,
          id: `${provider}-internal-id`,
          label: `${provider}-server-label`,
          isActive: true,
        };
  });
}

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  let reject: (reason?: unknown) => void = () => {};
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("parseSavedProviderStatus", () => {
  it("reduces valid missing rows to fixed, redacted scopes", () => {
    expect(parseSavedProviderStatus(response(rows("missing")))).toEqual({
      real_debrid: "missing",
      all_debrid: "missing",
      premiumize: "missing",
      torbox: "missing",
    });
  });

  it("rejects invalid scope, inactive configured rows, malformed rows, duplicates, and oversized arrays", () => {
    const invalidScope = rows("missing");
    invalidScope[3] = {
      provider: "torbox",
      scope: "account",
      id: "not-rendered",
      label: "not-rendered",
      isActive: true,
    };
    expect(parseSavedProviderStatus(response(invalidScope))).toBeNull();

    const inactive = rows("server");
    inactive[3] = { ...inactive[3], isActive: false };
    expect(parseSavedProviderStatus(response(inactive))).toBeNull();

    const malformed = rows("missing");
    malformed[2] = { provider: "premiumize", scope: null, id: "unexpected", label: null };
    expect(parseSavedProviderStatus(response(malformed))).toBeNull();

    expect(parseSavedProviderStatus(response([...rows("missing"), rows("missing")[0]!]))).toBeNull();
    expect(
      parseSavedProviderStatus(response(Array.from({ length: 33 }, () => ({ provider: "tmdb" })))),
    ).toBeNull();
  });

  it("ignores non-debrid metadata without treating it as a provider", () => {
    const status = parseSavedProviderStatus(
      response([
        ...rows("server"),
        { provider: "tmdb", scope: "server", id: "other-id", label: "other-label" },
      ]),
    );
    expect(status?.torbox).toBe("server");
  });
});

describe("ServerProviderStatus", () => {
  it("does not load or add status UI in Local Mode", () => {
    const loadStatus = vi.fn();
    render(
      <ServerProviderStatus
        enabled={false}
        service="torbox"
        profileId={null}
        role={null}
        isKid={false}
        loadStatus={loadStatus}
      >
        <input aria-label="candidate token" />
      </ServerProviderStatus>,
    );

    expect(screen.getByLabelText("candidate token")).toBeInTheDocument();
    expect(screen.queryByText(/Saved configuration only/)).not.toBeInTheDocument();
    expect(loadStatus).not.toHaveBeenCalled();
  });

  it("requires a profile before attempting a Server Mode status load", () => {
    const loadStatus = vi.fn();
    render(
      <ServerProviderStatus
        enabled
        service="torbox"
        profileId={null}
        role="owner"
        isKid={false}
        loadStatus={loadStatus}
      >
        <input aria-label="candidate token" />
      </ServerProviderStatus>,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("Saved provider status could not be loaded");
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("candidate token")).not.toBeInTheDocument();
    expect(loadStatus).not.toHaveBeenCalled();
  });

  it("keeps loading distinct from a valid missing status", async () => {
    const pending = deferred<unknown>();
    const loadStatus = vi.fn(() => pending.promise);
    render(
      <ServerProviderStatus
        enabled
        service="torbox"
        profileId="profile-a"
        role="member"
        isKid={false}
        loadStatus={loadStatus}
      >
        <input aria-label="candidate token" />
      </ServerProviderStatus>,
    );

    expect(await screen.findByRole("status")).toHaveTextContent("Loading saved provider status");
    expect(screen.queryByText(/No TorBox credential is available/)).not.toBeInTheDocument();
    pending.resolve(response(rows("missing")));
    expect(await screen.findByText(/No TorBox credential is available to this profile/)).toBeInTheDocument();
  });

  it("uses fixed labels, an unnumbered non-priority summary, and never renders metadata", async () => {
    const loadStatus = vi.fn(async () =>
      response([
        ...rows("server"),
        { provider: "tmdb", scope: "server", id: "other-id", label: "other-label" },
      ]),
    );
    render(
      <ServerProviderStatus
        enabled
        service="torbox"
        profileId="profile-a"
        role="owner"
        isKid={false}
        loadStatus={loadStatus}
      >
        <input aria-label="candidate token" />
      </ServerProviderStatus>,
    );

    expect(await screen.findByText(/Configured providers, not priority order: TorBox/)).toBeInTheDocument();
    expect(screen.getByText(/This profile uses a TorBox credential shared by the server/)).toBeInTheDocument();
    expect(screen.queryByText(/internal-id|server-label|other-id|other-label/)).not.toBeInTheDocument();
  });

  it("shows the generic error and retries without rendering an error value", async () => {
    const loadStatus = vi
      .fn<() => Promise<unknown>>()
      .mockRejectedValueOnce(new Error("raw internal server failure"))
      .mockResolvedValueOnce(response(rows("missing")));
    const user = userEvent.setup();
    render(
      <ServerProviderStatus
        enabled
        service="torbox"
        profileId="profile-a"
        role="owner"
        isKid={false}
        loadStatus={loadStatus}
      >
        <input aria-label="candidate token" />
      </ServerProviderStatus>,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Saved provider status could not be loaded. No credentials were changed.",
    );
    expect(screen.queryByText("raw internal server failure")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText(/No TorBox credential is saved for this profile/)).toBeInTheDocument();
    expect(loadStatus).toHaveBeenCalledTimes(2);
  });

  it("hides candidate controls for restricted, kid, and unknown roles", async () => {
    const loadStatus = vi.fn(async () => response(rows("missing")));
    const { rerender } = render(
      <ServerProviderStatus
        enabled
        service="torbox"
        profileId="profile-a"
        role="restricted"
        isKid={false}
        loadStatus={loadStatus}
      >
        <input aria-label="candidate token" />
      </ServerProviderStatus>,
    );

    expect(await screen.findByText(/managed by the server administrator/)).toBeInTheDocument();
    expect(screen.queryByLabelText("candidate token")).not.toBeInTheDocument();

    rerender(
      <ServerProviderStatus enabled service="torbox" profileId="profile-a" role="member" isKid loadStatus={loadStatus}>
        <input aria-label="candidate token" />
      </ServerProviderStatus>,
    );
    expect(screen.queryByLabelText("candidate token")).not.toBeInTheDocument();

    rerender(
      <ServerProviderStatus enabled service="torbox" profileId="profile-a" role={null} isKid={false} loadStatus={loadStatus}>
        <input aria-label="candidate token" />
      </ServerProviderStatus>,
    );
    expect(screen.queryByLabelText("candidate token")).not.toBeInTheDocument();
  });

  it("fences stale results immediately when the profile changes", async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    const loadStatus = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { rerender } = render(
      <ServerProviderStatus enabled service="torbox" profileId="profile-a" role="owner" isKid={false} loadStatus={loadStatus}>
        <input aria-label="candidate token" />
      </ServerProviderStatus>,
    );

    rerender(
      <ServerProviderStatus enabled service="torbox" profileId="profile-b" role="owner" isKid={false} loadStatus={loadStatus}>
        <input aria-label="candidate token" />
      </ServerProviderStatus>,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Loading saved provider status");

    first.resolve(response(rows("profile")));
    await Promise.resolve();
    expect(screen.getByRole("status")).toHaveTextContent("Loading saved provider status");

    second.resolve(response(rows("missing")));
    expect(await screen.findByText(/No TorBox credential is saved for this profile/)).toBeInTheDocument();
  });

  it("ignores late results after unmount and through StrictMode setup", async () => {
    const pending = deferred<unknown>();
    const loadStatus = vi.fn(() => pending.promise);
    const { unmount } = render(
      <StrictMode>
        <ServerProviderStatus enabled service="torbox" profileId="profile-a" role="owner" isKid={false} loadStatus={loadStatus}>
          <input aria-label="candidate token" />
        </ServerProviderStatus>
      </StrictMode>,
    );

    expect(loadStatus).toHaveBeenCalled();
    unmount();
    pending.resolve(response(rows("profile")));
    await waitFor(() => expect(screen.queryByText(/Saved configuration only/)).not.toBeInTheDocument());
  });
});

// @vitest-environment jsdom
// Unit tests for the server status subpanels and utility formatting. These tests focus
// on branches that are not sufficiently covered by the Settings-level integration
// coverage.

import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ComponentProps } from "react";

import type { RequestRecord } from "../../lib/serverApi";
import {
  ActiveStreamsPanel,
  formatShortDate,
  PasswordPanel,
  ProfileCredentialPanel,
  RequestQueuePanel,
  ServerAuditPanel,
  ServerHealthPanel,
  ServerUsagePanel,
  SessionsPanel,
  type ActiveStreamSession,
  type EffectiveCredential,
  type ServerAuditEvent,
  type ServerHealth,
  type ServerSessionEntry,
  type ServerUsage,
} from "./ServerStatusPanels";

// ProfileCredentialDraft is module-private in v2.1.0, so derive it from the
// component's own prop type rather than re-declaring a copy that can drift.
type ProfileCredentialDraft = ComponentProps<typeof ProfileCredentialPanel>["draft"];

const user = userEvent.setup();

describe("formatShortDate", () => {
  it("returns a stable fallback for missing dates", () => {
    expect(formatShortDate(null)).toBe("Never");
    expect(formatShortDate(undefined)).toBe("Never");
  });

  it("formats valid ISO values", () => {
    const formatted = formatShortDate("2026-06-01T12:30:00.000Z");
    expect(formatted).toMatch(/Jun/);
    expect(formatted).toMatch(/:30/);
  });
});

describe("ServerAuditPanel", () => {
  it("renders a no-events state", () => {
    render(<ServerAuditPanel events={[]} />);
    expect(screen.getByText("No recent audit events.")).toBeInTheDocument();
  });

  it("renders target and actor fallbacks", () => {
    const events: ServerAuditEvent[] = [
      {
        id: "e1",
        actorUserId: null,
        actorProfileId: null,
        actorUsername: null,
        actorDisplayName: null,
        action: "server.maintenance",
        targetType: null,
        targetId: null,
        metadata: null,
        createdAt: "2026-06-01T12:00:00.000Z",
      },
    ];

    render(<ServerAuditPanel events={events} />);

    expect(screen.getByText("server")).toBeInTheDocument();
    expect(screen.getByText("by System")).toBeInTheDocument();
    expect(screen.getByText("Server Maintenance")).toBeInTheDocument();
  });

  it("formats explicit target pair values", () => {
    const events: ServerAuditEvent[] = [
      {
        id: "e2",
        actorUserId: "u1",
        actorProfileId: "p1",
        actorUsername: "owner",
        actorDisplayName: "Owner Name",
        action: "credential.updated",
        targetType: "profile",
        targetId: "p1",
        metadata: null,
        createdAt: "2026-06-01T12:00:00.000Z",
      },
    ];

    render(<ServerAuditPanel events={events} />);

    expect(screen.getByText("profile:p1")).toBeInTheDocument();
    expect(screen.getByText("by Owner Name")).toBeInTheDocument();
  });
});

describe("ServerHealthPanel", () => {
  it("renders flags for boolean and setup branches", () => {
    const health: ServerHealth = {
      ok: false,
      serverTime: "2026-06-01T12:00:00.000Z",
      setupRequired: true,
      counts: {
        users: 4,
        profiles: 1,
        activeSessions: 3,
        activeStreamSessions: 2,
        credentials: 5,
        activeInvites: 0,
        auditEvents: 8,
        recentStreamErrors: 1,
        passwordlessProfiles: 2,
      },
      config: {
        cookieSecure: false,
        cookieSameSite: "strict",
        trustProxy: true,
        corsConfigured: true,
        rawStreamUrlsEnabled: true,
        webDistConfigured: false,
        sessionTtlSeconds: 60,
        bindSessionUserAgent: true,
        publicMode: false,
      },
      warnings: ["Server is running in setup mode", "Low disk space"],
    };

    render(<ServerHealthPanel health={health} />);

    expect(screen.getByText("Check")).toBeInTheDocument();
    expect(screen.getByText(/Cookies not secure/)).toBeInTheDocument();
    expect(screen.getByText(/SameSite/)).toBeInTheDocument();
    expect(screen.getByText(/Proxy trusted/)).toBeInTheDocument();
    expect(screen.getByText(/API only/)).toBeInTheDocument();
    expect(screen.getByText(/Raw stream sessions on/)).toBeInTheDocument();
    expect(screen.getByText(/Private mode/)).toBeInTheDocument();
    expect(screen.getByText(/Sessions bound to device/)).toBeInTheDocument();
    expect(screen.getByText("Server is running in setup mode")).toBeInTheDocument();
    expect(screen.getByText("Low disk space")).toBeInTheDocument();
    expect(screen.getByText(/Last checked/)).toBeInTheDocument();
  });
});

describe("ActiveStreamsPanel", () => {
  it("renders empty and then populated stream rows", async () => {
    const { rerender } = render(<ActiveStreamsPanel streams={[]} onRevoke={vi.fn()} />);
    expect(screen.getByText("No active stream sessions.")).toBeInTheDocument();

    const streams: ActiveStreamSession[] = [
      {
        id: "s1",
        profileId: "p1",
        username: "alice",
        displayName: "Alice",
        title: "Open movie",
        contentType: "movie",
        createdAt: "2026-06-01T10:00:00.000Z",
        expiresAt: "2026-06-01T11:00:00.000Z",
        bytesServed: 2048,
        lastAccessedAt: null,
        lastStatus: 200,
        lastError: null,
      },
    ];
    const revoke = vi.fn();

    rerender(<ActiveStreamsPanel streams={streams} onRevoke={revoke} />);

    expect(screen.getByText("Open movie")).toBeInTheDocument();
    expect(screen.getByText((content) => content.includes("Alice") && content.includes("alice"))).toBeInTheDocument();
    expect(screen.getByText("HTTP 200")).toBeInTheDocument();
    expect(screen.getByText(/Started Jun/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Terminate" }));
    expect(revoke).toHaveBeenCalledWith("s1");
  });

  it("shows last access and error text when available", () => {
    const streams: ActiveStreamSession[] = [
      {
        id: "s2",
        profileId: "p1",
        username: "bob",
        displayName: "Bob",
        title: null,
        contentType: null,
        createdAt: "2026-06-01T10:00:00.000Z",
        expiresAt: "2026-06-01T11:00:00.000Z",
        bytesServed: 16,
        lastAccessedAt: "2026-06-01T10:45:00.000Z",
        lastStatus: null,
        lastError: "transient net failure",
      },
    ];

    render(<ActiveStreamsPanel streams={streams} onRevoke={vi.fn()} />);

    expect(screen.getByText("Stream session")).toBeInTheDocument();
    expect(screen.getByText(/Last Jun/)).toBeInTheDocument();
    expect(screen.getByText("transient net failure")).toBeInTheDocument();
  });
});

describe("RequestQueuePanel", () => {
  const request: RequestRecord = {
    id: "r1",
    mediaId: "m1",
    preview: { id: "m1", type: "movie", title: "Incoming title", year: 2026 },
    status: "pending",
    decisionReason: null,
    requestedAt: "2026-06-01T09:00:00.000Z",
    decidedAt: null,
    requestedByDisplayName: "Reviewer",
    decidedByDisplayName: null,
  };

  it("posts approvals immediately", async () => {
    const onApprove = vi.fn();
    const onDeny = vi.fn();

    render(<RequestQueuePanel requests={[request]} onApprove={onApprove} onDeny={onDeny} />);

    await user.click(screen.getByRole("button", { name: "Approve" }));
    expect(onApprove).toHaveBeenCalledWith("r1");
    expect(onDeny).not.toHaveBeenCalled();
  });

  it("denies with prompt value and cancels when prompt is dismissed", async () => {
    const onApprove = vi.fn();
    const onDeny = vi.fn();
    const promptSpy = vi.spyOn(window, "prompt");

    render(<RequestQueuePanel requests={[request]} onApprove={onApprove} onDeny={onDeny} />);

    promptSpy.mockReturnValueOnce(null);
    await user.click(screen.getByRole("button", { name: "Deny" }));
    expect(onDeny).not.toHaveBeenCalled();

    promptSpy.mockReturnValueOnce("not needed");
    await user.click(screen.getByRole("button", { name: "Deny" }));
    expect(onDeny).toHaveBeenCalledWith("r1", "not needed");
    expect(onApprove).not.toHaveBeenCalled();

    promptSpy.mockRestore();
  });

  it("renders no pending requests state", () => {
    render(<RequestQueuePanel requests={[]} onApprove={vi.fn()} onDeny={vi.fn()} />);
    expect(screen.getByText("No pending title requests.")).toBeInTheDocument();
  });
});

describe("PasswordPanel", () => {
  it("respects disabled state and propagates draft changes", async () => {
    const onSave = vi.fn();
    const onDraftChange = vi.fn();

    const { rerender } = render(
      <PasswordPanel
        draft={{ currentPassword: "old", newPassword: "", confirmPassword: "" }}
        onDraftChange={onDraftChange}
        onSave={onSave}
        saving={true}
      />,
    );

    expect(screen.getByRole("button", { name: "Changing…" })).toBeDisabled();

    rerender(
      <PasswordPanel
        draft={{ currentPassword: "old", newPassword: "", confirmPassword: "" }}
        onDraftChange={onDraftChange}
        onSave={onSave}
        saving={false}
      />,
    );

    await user.type(screen.getByPlaceholderText("New password"), "abc");
    await user.type(screen.getByPlaceholderText("Confirm new password"), "abc");

    expect(onDraftChange).toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Change password" }));
    expect(onSave).toHaveBeenCalled();
  });
});

describe("SessionsPanel", () => {
  it("covers current/active/revoked states and platform labeling", async () => {
    const onRevoke = vi.fn();
    const onRevokeAll = vi.fn();
    const sessions: ServerSessionEntry[] = [
      {
        id: "x1",
        userAgent: null,
        ipHash: null,
        createdAt: "2026-06-01T10:00:00.000Z",
        expiresAt: "2026-06-01T11:00:00.000Z",
        revokedAt: null,
        current: true,
        active: true,
      },
      {
        id: "x2",
        userAgent: "Mozilla Linux",
        ipHash: null,
        createdAt: "2026-06-01T09:00:00.000Z",
        expiresAt: "2026-06-01T09:30:00.000Z",
        revokedAt: "2026-06-01T09:40:00.000Z",
        current: false,
        active: false,
      },
    ];

    render(<SessionsPanel sessions={sessions} onRevoke={onRevoke} onRevokeAll={onRevokeAll} />);

    expect(screen.getAllByText("1 active")).not.toHaveLength(0);
    expect(screen.getByText("Current session")).toBeInTheDocument();
    expect(screen.getByText("Linux")).toBeInTheDocument();
    expect(screen.getByText(/Revoked/)).toBeInTheDocument();

    // only revoked/inactive should show no revoke; current session also has no revoke
    expect(screen.queryByRole("button", { name: "Revoke" })).toBeNull();

    // now show a second non-current active session that is revokeable.
    const revoked: ServerSessionEntry[] = [
      {
        id: "x3",
        userAgent: "Mozilla Windows",
        ipHash: null,
        createdAt: "2026-06-01T07:00:00.000Z",
        expiresAt: "2026-06-01T08:00:00.000Z",
        revokedAt: null,
        current: false,
        active: true,
      },
    ];

    const { rerender } = render(
      <SessionsPanel sessions={revoked} onRevoke={onRevoke} onRevokeAll={onRevokeAll} />,
    );
    await user.click(screen.getByRole("button", { name: "Revoke" }));
    expect(onRevoke).toHaveBeenCalledWith("x3");

    rerender(<SessionsPanel sessions={[]} onRevoke={onRevoke} onRevokeAll={onRevokeAll} />);
    expect(screen.getByText("No sessions found.")).toBeInTheDocument();
  });

  it("falls back to a raw user agent label for unknown clients", () => {
    render(
      <SessionsPanel
        sessions={[
          {
            id: "unknown-ua",
            userAgent: "SuperTV Browser/7.2",
            ipHash: null,
            createdAt: "2026-06-01T08:30:00.000Z",
            expiresAt: "2026-06-01T09:00:00.000Z",
            revokedAt: null,
            current: true,
            active: true,
          },
        ]}
        onRevoke={vi.fn()}
        onRevokeAll={vi.fn()}
      />,
    );

    expect(screen.getByText("SuperTV Browser/7.2")).toBeInTheDocument();
  });
});

describe("ProfileCredentialPanel", () => {
  function StatefulPanel() {
    const [draft, setDraft] = useState<ProfileCredentialDraft>({
      provider: "tmdb",
      label: "Shared",
      value: "",
    });

    return (
      <ProfileCredentialPanel
        credentials={[
          {
            id: "c1",
            provider: "tmdb",
            scope: "server",
            label: "Shared",
            isActive: true,
          },
          {
            id: "c2",
            provider: "torbox",
            scope: "profile",
            label: "Private",
            isActive: false,
          },
          {
            id: null,
            provider: "openai",
            scope: null,
            label: null,
          },
        ]}
        draft={draft}
        onDraftChange={setDraft}
        onSave={() => {}
        }
        onDelete={() => {}}
        saving={false}
      />
    );
  }

  it("updates select and label state from handlers", async () => {
    render(<StatefulPanel />);

    const provider = screen.getByLabelText("Profile credential provider");
    const label = screen.getByPlaceholderText("Label");

    expect(screen.getByText("Shared server")).toBeInTheDocument();
    expect(screen.getByText("Profile override")).toBeInTheDocument();

    await user.selectOptions(provider, "openai");
    expect((provider as HTMLSelectElement).value).toBe("openai");

    await user.clear(label);
    await user.type(label, "OpenAI-key");
    expect((label as HTMLInputElement).value).toBe("OpenAI-key");
  });

  it("shows scope labels and removes profile credentials", async () => {
    const credentials: EffectiveCredential[] = [
      { id: "a1", provider: "tmdb", scope: "server", label: "Shared" },
      { id: "a2", provider: "torbox", scope: "profile", label: "Private" },
      { id: null, provider: "openai", scope: null, label: null },
    ];
    const onDelete = vi.fn();

    const draft: ProfileCredentialDraft = {
      provider: "tmdb",
      label: "Shared",
      value: "abc",
    };

    render(
      <ProfileCredentialPanel
        credentials={credentials}
        draft={draft}
        onDraftChange={() => {}}
        onSave={() => {}}
        onDelete={onDelete}
        saving={false}
      />,
    );

    expect(screen.getByText("Profile override")).toBeInTheDocument();
    expect(screen.getByText("Shared server")).toBeInTheDocument();
    expect(screen.getByText("Missing")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Remove" }));
    expect(onDelete).toHaveBeenCalledWith("a2");
  });
});

describe("ServerUsagePanel", () => {
  it("renders usage rows including profile and session entries", () => {
    const usage: ServerUsage = {
      days: 14,
      totalBytes: 10_485_760,
      streamCount: 12,
      lastAccessedAt: null,
      profiles: [
        {
          profileId: "p1",
          username: "owner",
          displayName: "Owner",
          role: "owner",
          totalBytes: 1024,
          streamCount: 2,
          lastAccessedAt: "2026-06-01T09:00:00.000Z",
          bandwidthCapBytes: 10_485_760,
          bandwidthUsageBytes: 5_242_880,
          bandwidthStatus: "approaching",
        },
      ],
      sessions: [
        {
          id: "su1",
          title: "Movie one",
          contentType: "movie",
          createdAt: "2026-06-01T08:00:00.000Z",
          bytesServed: 8192,
          lastAccessedAt: "2026-06-01T08:30:00.000Z",
        } as any,
      ],
    };

    render(<ServerUsagePanel usage={usage} />);

    expect(screen.getByText("Stream forwarding")).toBeInTheDocument();
    expect(screen.getByText("Movie one")).toBeInTheDocument();
    expect(screen.getByText("Owner")).toBeInTheDocument();
    expect(screen.getByText(/approaching/)).toBeInTheDocument();
  });

  it("handles absent profile and session lists", () => {
    render(<ServerUsagePanel usage={{ days: 7, totalBytes: 0, streamCount: 0 }} />);

    expect(screen.getByText("0 B")).toBeInTheDocument();
    expect(screen.getByText("Never")).toBeInTheDocument();
  });
});

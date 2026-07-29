// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { TraktDeviceCodeResponse, TraktTokenResponse } from "../services/sync/models";
import { TraktSyncError } from "../services/sync/types";
import type { TraktDeviceAuthService } from "./TraktConnectDialog";

const saveTraktTokens = vi.hoisted(() => vi.fn());
const defaultStartDeviceAuth = vi.hoisted(() => vi.fn(async () => ({
  deviceCode: "default-device",
  userCode: "WXYZ-0000",
  verificationURL: "https://trakt.tv/activate",
  expiresIn: 60,
  interval: 1,
})));
const defaultExchangeDeviceCode = vi.hoisted(() => vi.fn(async () => token()));

vi.mock("../data/traktConnection", () => ({ saveTraktTokens }));
vi.mock("./useModalA11y", () => ({ useModalA11y: () => ({ current: null }) }));
vi.mock("./Icon", () => ({ Icon: ({ name }: { name: string }) => <i data-icon={name} /> }));
vi.mock("../services/sync/TraktSyncService", () => ({
  TraktSyncService: function TraktSyncServiceMock() {
    return {
      startDeviceAuth: defaultStartDeviceAuth,
      exchangeDeviceCode: defaultExchangeDeviceCode,
    };
  },
}));

import { TraktConnectDialog } from "./TraktConnectDialog";

function token(): TraktTokenResponse {
  return {
    accessToken: "access",
    refreshToken: "refresh",
    expiresIn: 3600,
    tokenType: "bearer",
    scope: "public",
    createdAt: 1,
  };
}

function service(overrides: Partial<TraktDeviceAuthService> = {}): TraktDeviceAuthService {
  return {
    startDeviceAuth: vi.fn(async () => ({
      deviceCode: "device-code",
      userCode: "ABCD-EFGH",
      verificationURL: "https://trakt.tv/activate",
      expiresIn: 60,
      interval: 1,
    })),
    exchangeDeviceCode: vi.fn(async () => token()),
    ...overrides,
  };
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  saveTraktTokens.mockReset();
  saveTraktTokens.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("TraktConnectDialog", () => {
  it("starts device auth on mount and renders the device code and URL", async () => {
    const auth = service();
    render(
      <TraktConnectDialog
        clientId="client"
        clientSecret="secret"
        onClose={() => {}}
        onConnected={() => {}}
        service={auth}
      />,
    );
    await flush();

    expect(auth.startDeviceAuth).toHaveBeenCalledWith("client");
    expect(screen.getByLabelText("Trakt device code")).toHaveTextContent("ABCD-EFGH");
    expect(screen.getByRole("link", { name: "https://trakt.tv/activate" })).toHaveAttribute(
      "href",
      "https://trakt.tv/activate",
    );
  });

  it("keeps polling after Trakt returns a pending 400", async () => {
    const exchangeDeviceCode = vi.fn(async () => {
      throw TraktSyncError.httpStatus(400, "authorization_pending");
    });
    const auth = service({ exchangeDeviceCode });
    render(
      <TraktConnectDialog
        clientId="client"
        clientSecret="secret"
        onClose={() => {}}
        onConnected={() => {}}
        service={auth}
      />,
    );
    await flush();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(exchangeDeviceCode).toHaveBeenCalledTimes(2);
  });

  it("persists an approved token and closes", async () => {
    const onClose = vi.fn();
    const onConnected = vi.fn();
    const auth = service();
    render(
      <TraktConnectDialog
        clientId="client"
        clientSecret="secret"
        onClose={onClose}
        onConnected={onConnected}
        service={auth}
      />,
    );
    await flush();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(saveTraktTokens).toHaveBeenCalledWith(token());
    expect(onConnected).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("clears the pending poll timer on unmount", async () => {
    const exchangeDeviceCode = vi.fn(async () => token());
    const auth = service({ exchangeDeviceCode });
    const { unmount } = render(
      <TraktConnectDialog
        clientId="client"
        clientSecret="secret"
        onClose={() => {}}
        onConnected={() => {}}
        service={auth}
      />,
    );
    await flush();
    unmount();

    expect(vi.getTimerCount()).toBe(0);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(exchangeDeviceCode).not.toHaveBeenCalled();
  });

  it("shows the failed state when device auth cannot start", async () => {
    const auth = service({ startDeviceAuth: vi.fn(async () => {
      throw new Error("network-down");
    })});
    render(
      <TraktConnectDialog
        clientId="client"
        clientSecret="secret"
        onClose={() => {}}
        onConnected={() => {}}
        service={auth}
      />,
    );
    await flush();

    expect(screen.getByRole("alert")).toHaveTextContent("network-down");
  });

  it("shows the failed state when token exchange throws a non-pending error", async () => {
    const exchangeDeviceCode = vi.fn(async () => {
      throw new Error("token-denied");
    });
    const auth = service({ exchangeDeviceCode });
    render(
      <TraktConnectDialog
        clientId="client"
        clientSecret="secret"
        onClose={() => {}}
        onConnected={() => {}}
        service={auth}
      />,
    );
    await flush();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    expect(screen.getByRole("alert")).toHaveTextContent("token-denied");
  });

  it("marks the flow as expired when the device code expires", async () => {
    const auth = service({ exchangeDeviceCode: vi.fn(async () => token()) });
    auth.startDeviceAuth = vi.fn(async () => ({
      deviceCode: "device-code",
      userCode: "ABCD-EFGH",
      verificationURL: "https://trakt.tv/activate",
      expiresIn: 1,
      interval: 10,
    }));

    render(
      <TraktConnectDialog
        clientId="client"
        clientSecret="secret"
        onClose={() => {}}
        onConnected={() => {}}
        service={auth}
      />,
    );
    await flush();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "This code expired. Close this dialog and try again.",
    );
  });

  it("does not close when clicking inside the dialog", async () => {
    const onClose = vi.fn();
    const auth = service();
    render(
      <TraktConnectDialog
        clientId="client"
        clientSecret="secret"
        onClose={onClose}
        onConnected={() => {}}
        service={auth}
      />,
    );
    await flush();

    fireEvent.click(screen.getByRole("dialog"));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("uses the default service when no service is provided", async () => {
    defaultStartDeviceAuth.mockClear();
    defaultExchangeDeviceCode.mockClear();
    render(
      <TraktConnectDialog
        clientId="client"
        clientSecret="secret"
        onClose={() => {}}
        onConnected={() => {}}
      />,
    );
    await flush();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    expect(defaultStartDeviceAuth).toHaveBeenCalledOnce();
    expect(defaultExchangeDeviceCode).toHaveBeenCalledOnce();
  });

  it("shows the loading state while the device code request is in flight", async () => {
    let release!: (value: TraktDeviceCodeResponse) => void;
    const pending = new Promise<TraktDeviceCodeResponse>((resolve) => {
      release = resolve;
    });
    const startDeviceAuth = vi.fn(
      async () => {
        return pending;
      },
    );
    const auth = service({ startDeviceAuth });
    render(
      <TraktConnectDialog
        clientId="client"
        clientSecret="secret"
        onClose={() => {}}
        onConnected={() => {}}
        service={auth}
      />,
    );

    expect(screen.getByText("Requesting a Trakt device code…")).toBeInTheDocument();
    expect(startDeviceAuth).toHaveBeenCalledTimes(1);

    // Keep control of the async request so we can prove cleanup paths without
    // waiting for timers.
    release({
      deviceCode: "device-code",
      userCode: "LOADING-1",
      verificationURL: "https://trakt.tv/activate",
      expiresIn: 99,
      interval: 1,
    });
    await flush();

    expect(screen.queryByText("Requesting a Trakt device code…")).not.toBeInTheDocument();
  });

  it("uses the fallback string for non-Error failures", async () => {
    const auth = service({
      startDeviceAuth: vi.fn(async () => {
        throw "string-failure";
      }),
    });

    render(
      <TraktConnectDialog
        clientId="client"
        clientSecret="secret"
        onClose={() => {}}
        onConnected={() => {}}
        service={auth}
      />,
    );
    await flush();

    expect(screen.getByRole("alert")).toHaveTextContent("string-failure");
  });

  it("forwards outside click to onClose and keeps close button behavior explicit", async () => {
    const onClose = vi.fn();
    const { container } = render(
      <TraktConnectDialog
        clientId="client"
        clientSecret="secret"
        onClose={onClose}
        onConnected={() => {}}
        service={service()}
      />,
    );
    await flush();

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeInTheDocument();

    const backdrop = container.querySelector(".trakt-connect-backdrop");
    expect(backdrop).toBeTruthy();
    fireEvent.click(backdrop!);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("skips failure reporting after unmount before service settles", async () => {
    let settle: (reason: unknown) => void = () => {};
    const startDeviceAuth = vi.fn(
      async () =>
        new Promise<TraktDeviceCodeResponse>((_, reject) => {
          settle = reject;
        }),
    );
    const auth = service({ startDeviceAuth });
    const { unmount } = render(
      <TraktConnectDialog
        clientId="client"
        clientSecret="secret"
        onClose={() => {}}
        onConnected={() => {}}
        service={auth}
      />,
    );
    unmount();

    settle(new Error("late"));
    await flush();

    // No failure state should assert itself after the component unmounts.
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

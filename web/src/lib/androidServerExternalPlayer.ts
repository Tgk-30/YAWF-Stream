import {
  canonicalServerCapability,
  serverPlayerBridge,
  type ServerPlayerMessageEvent,
} from "./androidExternalPlayer";
import { assertNetworkAllowed, isRequestExempt } from "./networkPolicy";

const MAX_SERVER_PLAYER_MESSAGE_BYTES = 12 * 1024;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;
const CHALLENGE_PATTERN = /^[A-Fa-f0-9]{32,128}$/;

type ServerPlayerReply = {
  type: "pending" | "confirm" | "success" | "cancelled" | "error";
  requestId: string;
  challenge?: string;
};

function requestId(): string {
  const cryptoObject = globalThis.crypto;
  if (typeof cryptoObject?.randomUUID === "function") {
    return cryptoObject.randomUUID().replaceAll("-", "");
  }
  const bytes = new Uint8Array(16);
  cryptoObject?.getRandomValues?.(bytes);
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

function parseServerPlayerReply(value: unknown): ServerPlayerReply | null {
  if (
    typeof value !== "string" ||
    new TextEncoder().encode(value).byteLength > MAX_SERVER_PLAYER_MESSAGE_BYTES
  ) {
    return null;
  }
  try {
    const parsed = JSON.parse(value) as Partial<ServerPlayerReply>;
    if (
      !["pending", "confirm", "success", "cancelled", "error"].includes(parsed.type ?? "") ||
      typeof parsed.requestId !== "string" ||
      !REQUEST_ID_PATTERN.test(parsed.requestId)
    ) {
      return null;
    }
    if (
      parsed.type === "confirm" &&
      (typeof parsed.challenge !== "string" || !CHALLENGE_PATTERN.test(parsed.challenge))
    ) {
      return null;
    }
    return parsed as ServerPlayerReply;
  } catch {
    return null;
  }
}

export function openAndroidServerExternalPlayer(
  rawUrl: string,
  ownsRequest: () => boolean,
  signal: AbortSignal,
  onHandoff: () => void,
): Promise<string | null> {
  const bridge = serverPlayerBridge();
  if (bridge == null) {
    return Promise.reject(new Error("The Android player chooser is unavailable."));
  }

  let url: string;
  try {
    url = canonicalServerCapability(rawUrl);
  } catch {
    return Promise.reject(new Error("The Android player chooser is unavailable."));
  }
  if (!isRequestExempt(url)) {
    assertNetworkAllowed("streaming", "Android external player");
  }
  const id = requestId();
  if (!REQUEST_ID_PATTERN.test(id)) {
    return Promise.reject(new Error("The Android player chooser is unavailable."));
  }

  return new Promise<string | null>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      bridge.removeEventListener("message", handleMessage);
      signal.removeEventListener("abort", handleAbort);
    };
    const settle = (run: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      run();
    };
    const post = (message: Record<string, string>) => {
      bridge.postMessage(JSON.stringify(message));
    };
    const handleAbort = () => {
      try {
        post({ action: "cancel", requestId: id });
      } catch {
        // The document or WebView may already be gone.
      }
      settle(() => resolve(null));
    };
    const handleMessage = (event: ServerPlayerMessageEvent) => {
      const reply = parseServerPlayerReply(event.data);
      if (reply == null || reply.requestId !== id || settled) return;
      if (!ownsRequest() || signal.aborted) {
        handleAbort();
        return;
      }
      if (reply.type === "pending") return;
      if (reply.type === "confirm") {
        try {
          onHandoff();
          if (!ownsRequest() || signal.aborted) {
            handleAbort();
            return;
          }
          post({ action: "open", requestId: id, challenge: reply.challenge! });
        } catch {
          settle(() => reject(new Error("The Android player chooser could not be opened.")));
        }
        return;
      }
      if (reply.type === "success") {
        settle(() => resolve("External player opened."));
      } else if (reply.type === "cancelled") {
        settle(() => resolve("External player request canceled."));
      } else {
        settle(() => reject(new Error("The Android player chooser could not be opened.")));
      }
    };

    bridge.addEventListener("message", handleMessage);
    signal.addEventListener("abort", handleAbort, { once: true });
    if (signal.aborted || !ownsRequest()) {
      handleAbort();
      return;
    }
    try {
      post({ action: "open", requestId: id, url });
    } catch {
      settle(() => reject(new Error("The Android player chooser could not be opened.")));
    }
  });
}

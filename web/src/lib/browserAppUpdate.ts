import { assertNetworkAllowed } from "./networkPolicy";

export const BROWSER_APP_UPDATE_TIMEOUT_MS = 10_000;
export const BROWSER_APP_UPDATE_CHECK_CADENCE_MS = 30 * 60_000;
const MAX_INDEX_BYTES = 512 * 1024;
const ENTRY_PATH = /^\/assets\/index-([A-Za-z0-9_-]{8,})\.js$/;

export interface BrowserAppEntry {
  path: string;
  hash: string;
}

export interface BrowserAppUpdate {
  current: BrowserAppEntry;
  target: BrowserAppEntry;
}

export class BrowserAppUpdateCheckError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrowserAppUpdateCheckError";
  }
}

function entryFromDocument(documentValue: Document): BrowserAppEntry {
  if (documentValue.querySelector("base") != null) {
    throw new BrowserAppUpdateCheckError("The app document has an unsupported base URL.");
  }
  const scripts = [...documentValue.querySelectorAll<HTMLScriptElement>('script[type="module"][src]')];
  if (scripts.length !== 1) {
    throw new BrowserAppUpdateCheckError("The app document must contain one module entry.");
  }
  const raw = scripts[0]?.getAttribute("src") ?? "";
  const match = ENTRY_PATH.exec(raw);
  if (match == null) {
    throw new BrowserAppUpdateCheckError("The app document module entry is not a supported hashed asset path.");
  }
  return { path: raw, hash: match[1]! };
}

async function boundedResponseText(response: Response, signal: AbortSignal): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_INDEX_BYTES) {
    throw new BrowserAppUpdateCheckError("The app document was too large.");
  }
  if (response.body == null) {
    const text = await response.text();
    if (text.length > MAX_INDEX_BYTES) {
      throw new BrowserAppUpdateCheckError("The app document was too large.");
    }
    return text;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      if (signal.aborted) throw signal.reason;
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > MAX_INDEX_BYTES) {
        await reader.cancel().catch(() => {});
        throw new BrowserAppUpdateCheckError("The app document was too large.");
      }
      text += decoder.decode(next.value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } finally {
    reader.releaseLock();
  }
}

function parseTargetDocument(html: string, parser: DOMParser): Document {
  if (!/^\s*<!doctype html(?:\s|>)/i.test(html)) {
    throw new BrowserAppUpdateCheckError("The app response was not an application document.");
  }
  const parsed = parser.parseFromString(html, "text/html");
  if (parsed.querySelectorAll("#root").length !== 1) {
    throw new BrowserAppUpdateCheckError("The app response did not contain the application root.");
  }
  return parsed;
}

export async function checkBrowserAppUpdate(options: {
  document?: Document;
  fetchImpl?: typeof fetch;
  parser?: DOMParser;
  timeoutMs?: number;
  signal?: AbortSignal;
} = {}): Promise<BrowserAppUpdate | null> {
  assertNetworkAllowed("updates", "browser app entry check");
  const documentValue = options.document ?? document;
  const fetchImpl = options.fetchImpl ?? fetch;
  const parser = options.parser ?? new DOMParser();
  const current = entryFromDocument(documentValue);
  const expectedUrl = new URL("/", documentValue.baseURI);
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) abortFromCaller();
  else options.signal?.addEventListener("abort", abortFromCaller, { once: true });
  let timeout: ReturnType<typeof globalThis.setTimeout> | undefined;
  const timeoutMs = options.timeoutMs ?? BROWSER_APP_UPDATE_TIMEOUT_MS;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timeout = globalThis.setTimeout(() => {
      const error = new BrowserAppUpdateCheckError("The app update check timed out.");
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });
  try {
    const operation = (async () => {
      const response = await fetchImpl(expectedUrl, {
        method: "GET",
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        headers: { accept: "text/html" },
        signal: controller.signal,
      });
      if (!response.ok || response.status !== 200 || response.redirected) {
        throw new BrowserAppUpdateCheckError("The app update response was not a direct success.");
      }
      if (response.url.length > 0 && new URL(response.url).href !== expectedUrl.href) {
        throw new BrowserAppUpdateCheckError("The app update response changed origin or path.");
      }
      const contentType = response.headers.get("content-type") ?? "";
      if (!/^text\/html(?:\s*;|$)/i.test(contentType)) {
        throw new BrowserAppUpdateCheckError("The app update response was not HTML.");
      }
      const target = entryFromDocument(parseTargetDocument(
        await boundedResponseText(response, controller.signal),
        parser,
      ));
      return target.path === current.path ? null : { current, target };
    })();
    return await Promise.race([operation, timedOut]);
  } finally {
    globalThis.clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abortFromCaller);
  }
}

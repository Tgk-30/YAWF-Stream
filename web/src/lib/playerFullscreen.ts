/** Select capability and gesture paths together, always on the complete player owner. */
export type ContainerFullscreenElement = HTMLElement & {
  webkitRequestFullscreen?: () => void | Promise<void>;
};
export type FullscreenDocument = Document & {
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => void | Promise<void>;
};

export function containerFullscreenRequest(element: HTMLElement): (() => void | Promise<void>) | null {
  const target = element as ContainerFullscreenElement;
  if (typeof target.requestFullscreen === "function") return target.requestFullscreen.bind(target);
  if (typeof target.webkitRequestFullscreen === "function") return target.webkitRequestFullscreen.bind(target);
  return null;
}

export function containerFullscreenExit(doc: FullscreenDocument): (() => void | Promise<void>) | null {
  if (typeof doc.exitFullscreen === "function") return doc.exitFullscreen.bind(doc);
  if (typeof doc.webkitExitFullscreen === "function") return doc.webkitExitFullscreen.bind(doc);
  return null;
}

type FullscreenVideo = HTMLVideoElement & {
  webkitSupportsFullscreen?: boolean;
  webkitDisplayingFullscreen?: boolean;
  webkitPresentationMode?: string;
  webkitEnterFullscreen?: () => void;
  webkitExitFullscreen?: () => void;
};

// Legacy native APIs may return void and report neither success nor failure.
// Bound their input guard without scheduling a new request outside a gesture.
const FULLSCREEN_RETRY_AFTER_MS = 2500;
const fullscreenTransitions = new WeakMap<HTMLElement, { from: Element | null; at: number }>();

export function observePlayerFullscreen(container: HTMLElement, active: Element | null): void {
  const pending = fullscreenTransitions.get(container);
  if (pending != null && pending.from !== active) fullscreenTransitions.delete(container);
}

export function togglePlayerFullscreen(container: HTMLElement, video: FullscreenVideo): void {
  const doc = container.ownerDocument as FullscreenDocument;
  const documentFullscreen = doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null;
  const nativeFullscreen = video.webkitDisplayingFullscreen === true || video.webkitPresentationMode === "fullscreen";
  const active = documentFullscreen ?? (nativeFullscreen ? video : null);
  observePlayerFullscreen(container, active);
  const now = performance.now();
  const pending = fullscreenTransitions.get(container);
  if (pending != null && now - pending.at < FULLSCREEN_RETRY_AFTER_MS) return;

  let transition: (() => void | Promise<void>) | null;
  if (documentFullscreen != null) {
    transition = containerFullscreenExit(doc);
  } else if (nativeFullscreen) {
    transition = video.webkitExitFullscreen?.bind(video) ?? null;
  } else {
    transition = containerFullscreenRequest(container) ?? (
      video.webkitSupportsFullscreen === true ? video.webkitEnterFullscreen?.bind(video) ?? null : null
    );
  }
  if (transition == null) return;

  // Claim before calling. Button, keyboard and double-click feed the same
  // owner, but the first request must still run in the activating gesture.
  const claim = { from: active, at: now };
  fullscreenTransitions.set(container, claim);
  const failed = () => {
    if (fullscreenTransitions.get(container) === claim) fullscreenTransitions.delete(container);
  };
  try {
    void transition()?.catch(failed);
  } catch {
    failed();
  }
}

/** Only the current app page, never a playback/provider capability or query/hash. */
export function ipadSafariPageUrl(
  page: Pick<Location, "href" | "origin">,
  device: Pick<Navigator, "userAgent" | "platform" | "maxTouchPoints">,
  standalone: boolean,
  iosBrowser: boolean,
): string | null {
  const ua = device.userAgent.toLowerCase();
  const ipad = !/iphone|ipod/.test(ua) && (
    /ipad/.test(ua) || (device.platform.toLowerCase().includes("mac") && device.maxTouchPoints > 1)
  );
  if (!iosBrowser || !standalone || !ipad) return null;
  try {
    const url = new URL(page.href);
    if (!["http:", "https:"].includes(url.protocol) || url.origin !== page.origin) return null;
    return `${url.origin}${url.pathname}`;
  } catch {
    return null;
  }
}

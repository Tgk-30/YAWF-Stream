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

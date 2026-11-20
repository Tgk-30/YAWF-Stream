import { IOS_HLS_COMPATIBILITY_MIME, type IosHlsCapabilityScope } from "./iosHlsPlayback";

type ManagedIosHlsCapabilityScope = IosHlsCapabilityScope & {
  WebKitSourceBuffer?: IosHlsCapabilityScope["SourceBuffer"];
};

// iPhone WebKit can create working SourceBuffers without exposing the constructor globally.
export function supportsManagedIosHlsMse(scope: ManagedIosHlsCapabilityScope = globalThis): boolean {
  const managed = scope.ManagedMediaSource as typeof MediaSource | undefined;
  const buffer = scope.SourceBuffer ?? scope.WebKitSourceBuffer;
  try {
    return typeof managed === "function" &&
      typeof managed.isTypeSupported === "function" &&
      typeof managed.prototype?.addSourceBuffer === "function" &&
      (buffer == null || (
        typeof buffer.prototype?.appendBuffer === "function" &&
        typeof buffer.prototype?.remove === "function"
      )) &&
      managed.isTypeSupported(IOS_HLS_COMPATIBILITY_MIME);
  } catch {
    return false;
  }
}

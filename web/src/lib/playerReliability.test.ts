// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { mediaErrorMessage, nextHlsRecovery } from "./playerReliability";

describe("player reliability", () => {
  it("bounds automatic HLS network and media recovery", () => {
    expect(nextHlsRecovery("networkError", { networkRetries: 0, mediaRecoveries: 0 }))
      .toBe("retry-network");
    expect(nextHlsRecovery("networkError", { networkRetries: 2, mediaRecoveries: 0 }))
      .toBe("fail");
    expect(nextHlsRecovery("mediaError", { networkRetries: 0, mediaRecoveries: 0 }))
      .toBe("recover-media");
    expect(nextHlsRecovery("mediaError", { networkRetries: 0, mediaRecoveries: 1 }))
      .toBe("fail");
    expect(nextHlsRecovery("otherError", { networkRetries: 0, mediaRecoveries: 0 }))
      .toBe("fail");
  });

  it("turns media element error codes into useful recovery copy", () => {
    expect(mediaErrorMessage({ code: 2 } as MediaError))
      .toContain("stopped responding");
    expect(mediaErrorMessage({ code: 3 } as MediaError))
      .toContain("could not be decoded");
    expect(mediaErrorMessage({ code: 1 } as MediaError))
      .toContain("interrupted");
    expect(mediaErrorMessage({ code: 4 } as MediaError))
      .toContain("not supported");
    expect(mediaErrorMessage({ code: 99 } as MediaError))
      .toContain("could not continue");
    expect(mediaErrorMessage(null)).toContain("could not continue");
  });
});

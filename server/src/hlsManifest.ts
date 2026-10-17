export const MAX_HLS_MANIFEST_BYTES = 2 * 1024 * 1024;

const MAX_HLS_REFERENCES = 16_384;
const MAX_HLS_URL_LENGTH = 8_192;
const UNSAFE_URI_CHARACTER = /[\u0000-\u0020\u007f]/;

export type HlsReferenceKind = "manifest" | "asset";
export type HlsUriRewriter = (
  absoluteUrl: string,
  kind: HlsReferenceKind,
) => string;

interface Attribute {
  name: string;
  value: string;
  quoted: boolean;
  valueStart: number;
  valueEnd: number;
}

const ATTRIBUTE_URI_KINDS = new Map<string, HlsReferenceKind>([
  ["#EXT-X-KEY", "asset"],
  ["#EXT-X-MAP", "asset"],
  ["#EXT-X-MEDIA", "manifest"],
  ["#EXT-X-SESSION-KEY", "asset"],
  ["#EXT-X-I-FRAME-STREAM-INF", "manifest"],
  ["#EXT-X-IMAGE-STREAM-INF", "manifest"],
  ["#EXT-X-SESSION-DATA", "asset"],
  ["#EXT-X-PART", "asset"],
  ["#EXT-X-PRELOAD-HINT", "asset"],
  ["#EXT-X-RENDITION-REPORT", "manifest"],
]);

const MASTER_TAGS = new Set([
  "#EXT-X-MEDIA",
  "#EXT-X-STREAM-INF",
  "#EXT-X-I-FRAME-STREAM-INF",
  "#EXT-X-IMAGE-STREAM-INF",
  "#EXT-X-SESSION-DATA",
  "#EXT-X-SESSION-KEY",
]);

const MEDIA_TAGS = new Set([
  "#EXTINF",
  "#EXT-X-BYTERANGE",
  "#EXT-X-DISCONTINUITY",
  "#EXT-X-KEY",
  "#EXT-X-MAP",
  "#EXT-X-PROGRAM-DATE-TIME",
  "#EXT-X-DATERANGE",
  "#EXT-X-TARGETDURATION",
  "#EXT-X-MEDIA-SEQUENCE",
  "#EXT-X-DISCONTINUITY-SEQUENCE",
  "#EXT-X-ENDLIST",
  "#EXT-X-PLAYLIST-TYPE",
  "#EXT-X-I-FRAMES-ONLY",
  "#EXT-X-PART",
  "#EXT-X-PART-INF",
  "#EXT-X-SERVER-CONTROL",
  "#EXT-X-PRELOAD-HINT",
  "#EXT-X-RENDITION-REPORT",
  "#EXT-X-SKIP",
]);

function malformed(): never {
  throw new Error("Malformed HLS playlist.");
}

function invalidUri(): never {
  throw new Error("Invalid HLS playlist URI.");
}

function parseAttributeList(value: string): Attribute[] {
  const attributes: Attribute[] = [];
  const names = new Set<string>();
  let cursor = 0;

  while (cursor < value.length) {
    while (value[cursor] === " " || value[cursor] === "\t") cursor += 1;
    const nameStart = cursor;
    while (/[A-Z0-9-]/.test(value[cursor] ?? "")) cursor += 1;
    const name = value.slice(nameStart, cursor);
    if (name.length === 0 || names.has(name)) malformed();
    names.add(name);

    while (value[cursor] === " " || value[cursor] === "\t") cursor += 1;
    if (value[cursor] !== "=") malformed();
    cursor += 1;
    while (value[cursor] === " " || value[cursor] === "\t") cursor += 1;

    let quoted = false;
    let valueStart = cursor;
    let valueEnd = cursor;
    if (value[cursor] === '"') {
      quoted = true;
      valueStart = cursor + 1;
      valueEnd = value.indexOf('"', valueStart);
      if (valueEnd < 0) malformed();
      cursor = valueEnd + 1;
    } else {
      const rawEnd = value.indexOf(",", cursor);
      const end = rawEnd < 0 ? value.length : rawEnd;
      valueEnd = end;
      while (valueEnd > valueStart && /[ \t]/.test(value[valueEnd - 1])) {
        valueEnd -= 1;
      }
      cursor = end;
    }
    if (valueEnd === valueStart) malformed();

    while (value[cursor] === " " || value[cursor] === "\t") cursor += 1;
    if (cursor < value.length) {
      if (value[cursor] !== ",") malformed();
      cursor += 1;
      if (cursor === value.length) malformed();
    }

    attributes.push({
      name,
      value: value.slice(valueStart, valueEnd),
      quoted,
      valueStart,
      valueEnd,
    });
  }

  if (attributes.length === 0) malformed();
  return attributes;
}

function validateHttpUrl(value: string, base?: URL): URL {
  if (
    value.length === 0 ||
    value.length > MAX_HLS_URL_LENGTH ||
    UNSAFE_URI_CHARACTER.test(value)
  ) {
    invalidUri();
  }

  let resolved: URL;
  try {
    resolved = base == null ? new URL(value) : new URL(value, base);
  } catch {
    invalidUri();
  }
  if (
    (resolved.protocol !== "http:" && resolved.protocol !== "https:") ||
    resolved.username.length > 0 ||
    resolved.password.length > 0 ||
    resolved.href.length > MAX_HLS_URL_LENGTH
  ) {
    invalidUri();
  }
  return resolved;
}

function tagName(line: string): string {
  const colon = line.indexOf(":");
  return colon < 0 ? line : line.slice(0, colon);
}

function attributeMap(attributes: Attribute[]): Map<string, Attribute> {
  return new Map(attributes.map((attribute) => [attribute.name, attribute]));
}

function validateUriAttributeTag(
  tag: string,
  attributes: Map<string, Attribute>,
): Attribute | null {
  if ([...attributes.keys()].some((name) => name !== "URI" && name.endsWith("-URI"))) {
    throw new Error("Unsupported HLS playlist feature.");
  }
  const uri = attributes.get("URI") ?? null;

  if (tag === "#EXT-X-KEY") {
    const method = attributes.get("METHOD")?.value;
    if (method == null || (method === "NONE" ? uri != null : uri == null)) malformed();
  } else if (tag === "#EXT-X-SESSION-KEY") {
    if (attributes.get("METHOD")?.value == null || attributes.get("METHOD")?.value === "NONE" || uri == null) {
      malformed();
    }
  } else if (tag === "#EXT-X-MEDIA") {
    const type = attributes.get("TYPE")?.value;
    if (type == null) malformed();
    if (type === "SUBTITLES" && uri == null) malformed();
    if (type === "CLOSED-CAPTIONS" && uri != null) malformed();
  } else if (tag === "#EXT-X-SESSION-DATA") {
    const hasValue = attributes.has("VALUE");
    if (attributes.get("DATA-ID") == null || hasValue === (uri != null)) malformed();
  } else if (uri == null) {
    malformed();
  }

  if (uri != null && !uri.quoted) malformed();
  return uri;
}

function validateReplacement(value: string, base: URL, quoted: boolean): string {
  if (quoted && value.includes('"')) invalidUri();
  validateHttpUrl(value, base);
  return value;
}

/**
 * Rewrites every fetchable URI in an RFC 8216 playlist without normalizing
 * unrelated tags, whitespace, or line endings. The source URL must be the final
 * upstream response URL so relative references follow redirects correctly.
 */
export function rewriteHlsManifest(
  manifest: string,
  sourceUrl: string,
  rewrite: HlsUriRewriter,
): string {
  if (Buffer.byteLength(manifest, "utf8") > MAX_HLS_MANIFEST_BYTES) {
    throw new Error("HLS playlist exceeds the size limit.");
  }
  const firstLineEnd = manifest.search(/\r\n|\n|\r/);
  const firstLine = firstLineEnd < 0 ? manifest : manifest.slice(0, firstLineEnd);
  if (firstLine !== "#EXTM3U") throw new Error("Not an HLS playlist.");
  if (manifest.includes("\r") && /\r(?!\n)/.test(manifest)) malformed();
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(manifest)) malformed();

  const pieces = manifest.split(/(\r\n|\n)/);

  const base = validateHttpUrl(sourceUrl);
  let references = 0;
  let pendingManifestUri = false;
  let sawMasterTag = false;
  let sawMediaTag = false;
  let sawMasterVariant = false;
  let sawTargetDuration = false;

  const rewriteReference = (
    reference: string,
    kind: HlsReferenceKind,
    quoted: boolean,
  ): string => {
    references += 1;
    if (references > MAX_HLS_REFERENCES) {
      throw new Error("HLS playlist has too many URI references.");
    }
    const absolute = validateHttpUrl(reference, base).href;
    let replacement: string;
    try {
      replacement = rewrite(absolute, kind);
    } catch {
      throw new Error("Could not rewrite HLS playlist URI.");
    }
    if (typeof replacement !== "string") invalidUri();
    return validateReplacement(replacement, base, quoted);
  };

  for (let index = 2; index < pieces.length; index += 2) {
    const line = pieces[index];
    if (line.length === 0) {
      continue;
    }

    if (!line.startsWith("#")) {
      if (line.includes("{$")) {
        throw new Error("Unsupported HLS playlist feature.");
      }
      if (line.trim() !== line) malformed();
      if (!pendingManifestUri) sawMediaTag = true;
      if (sawMasterTag && sawMediaTag) malformed();
      pieces[index] = rewriteReference(
        line,
        pendingManifestUri ? "manifest" : "asset",
        false,
      );
      pendingManifestUri = false;
      continue;
    }

    if (!line.startsWith("#EXT")) continue;
    if (pendingManifestUri) malformed();
    if (line.includes("{$")) {
      throw new Error("Unsupported HLS playlist feature.");
    }
    const tag = tagName(line);
    if (tag === "#EXTM3U") malformed();
    if (tag === "#EXT-X-DEFINE" || tag === "#EXT-X-CONTENT-STEERING") {
      throw new Error("Unsupported HLS playlist feature.");
    }

    if (MASTER_TAGS.has(tag)) sawMasterTag = true;
    if (MEDIA_TAGS.has(tag)) sawMediaTag = true;
    if (tag === "#EXT-X-TARGETDURATION") sawTargetDuration = true;
    if (
      tag === "#EXT-X-STREAM-INF" ||
      tag === "#EXT-X-I-FRAME-STREAM-INF" ||
      tag === "#EXT-X-IMAGE-STREAM-INF"
    ) {
      sawMasterVariant = true;
    }
    if (sawMasterTag && sawMediaTag) malformed();

    if (tag === "#EXT-X-STREAM-INF") {
      const colon = line.indexOf(":");
      if (colon < 0) malformed();
      const attributes = attributeMap(parseAttributeList(line.slice(colon + 1)));
      if (!attributes.has("BANDWIDTH")) malformed();
      pendingManifestUri = true;
      continue;
    }

    if (tag === "#EXT-X-DATERANGE") {
      const colon = line.indexOf(":");
      if (colon < 0) malformed();
      const attributes = attributeMap(parseAttributeList(line.slice(colon + 1)));
      if (
        attributes.get("CLASS")?.value === "com.apple.hls.interstitial" ||
        attributes.has("X-ASSET-URI") ||
        attributes.has("X-ASSET-LIST")
      ) {
        throw new Error("Unsupported HLS playlist feature.");
      }
      continue;
    }

    const kind = ATTRIBUTE_URI_KINDS.get(tag);
    if (kind != null) {
      const colon = line.indexOf(":");
      if (colon < 0) malformed();
      const rawAttributes = line.slice(colon + 1);
      const attributes = parseAttributeList(rawAttributes);
      const uri = validateUriAttributeTag(tag, attributeMap(attributes));
      if (uri != null) {
        const replacement = rewriteReference(uri.value, kind, true);
        pieces[index] =
          line.slice(0, colon + 1 + uri.valueStart) +
          replacement +
          line.slice(colon + 1 + uri.valueEnd);
      }
      continue;
    }

    const colon = line.indexOf(":");
    if (
      colon >= 0 &&
      /(?:^|,)\s*(?:[A-Z0-9-]+-)?URI\s*=/.test(line.slice(colon + 1))
    ) {
      throw new Error("Unsupported HLS playlist feature.");
    }
  }

  if (pendingManifestUri) malformed();
  if (
    (!sawMasterTag && !sawMediaTag) ||
    (sawMasterTag && !sawMasterVariant) ||
    (sawMediaTag && !sawTargetDuration)
  ) {
    malformed();
  }
  const output = pieces.join("");
  if (Buffer.byteLength(output, "utf8") > MAX_HLS_MANIFEST_BYTES) {
    throw new Error("Rewritten HLS playlist exceeds the size limit.");
  }
  return output;
}

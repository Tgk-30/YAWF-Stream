import { createHash } from "node:crypto";

export type ExternalStreamAsset = {
  url: string;
  kind: "manifest" | "asset";
};

type AssetGroup = {
  expiresAt: number;
  assets: Map<string, ExternalStreamAsset>;
  urlBytes: number;
};

/** Only URLs discovered in an authorized stream's manifests are addressable.
 * This is not a URL-taking proxy. The route must validate the existing stream
 * grant and its database row before consulting this bounded, ephemeral index. */
export class ExternalStreamAssets {
  private readonly groups = new Map<string, AssetGroup>();
  private assetCount = 0;
  private urlBytes = 0;

  constructor(private readonly limits = {
    sessions: 64,
    assetsPerSession: 16_384,
    assets: 65_536,
    urlBytes: 32 * 1024 * 1024,
  }) {}

  static id(asset: ExternalStreamAsset): string {
    const digest = createHash("sha256")
      .update(asset.kind).update("\0").update(asset.url).digest("hex");
    // Media demuxers can validate the extension before reading response MIME.
    // Keep a bounded suffix, never a provider filename or query credential.
    const suffix = /\.([a-z0-9]{1,8})$/i.exec(new URL(asset.url).pathname)?.[1]?.toLowerCase();
    return `${digest}.${asset.kind === "manifest" ? "m3u8" : suffix ?? "ts"}`;
  }

  register(sessionId: string, expiresAt: string, entries: ExternalStreamAsset[]): void {
    this.prune();
    const expiry = Date.parse(expiresAt);
    if (!Number.isFinite(expiry) || expiry <= Date.now()) throw this.fullError();
    const existing = this.groups.get(sessionId);
    const additions = new Map<string, ExternalStreamAsset>();
    let addedBytes = 0;
    for (const asset of entries) {
      const id = ExternalStreamAssets.id(asset);
      if (existing?.assets.has(id) || additions.has(id)) continue;
      additions.set(id, { ...asset });
      addedBytes += Buffer.byteLength(asset.url);
    }
    if (
      (existing?.assets.size ?? 0) + additions.size > this.limits.assetsPerSession ||
      additions.size > this.limits.assets || addedBytes > this.limits.urlBytes
    ) throw this.fullError();
    // Retire least recently used other streams, never a partial current graph.
    while (
      this.assetCount + additions.size > this.limits.assets ||
      this.urlBytes + addedBytes > this.limits.urlBytes ||
      (existing == null && this.groups.size >= this.limits.sessions)
    ) {
      const oldest = [...this.groups.keys()].find((key) => key !== sessionId);
      if (oldest == null) throw this.fullError();
      this.remove(oldest);
    }
    const group = existing ?? { expiresAt: expiry, assets: new Map(), urlBytes: 0 };
    for (const [id, asset] of additions) group.assets.set(id, asset);
    group.urlBytes += addedBytes;
    this.assetCount += additions.size;
    this.urlBytes += addedBytes;
    this.groups.delete(sessionId);
    this.groups.set(sessionId, group);
  }

  get(sessionId: string, assetId: string): ExternalStreamAsset | null {
    this.prune();
    const group = this.groups.get(sessionId);
    const asset = group?.assets.get(assetId);
    if (group == null || asset == null) return null;
    this.groups.delete(sessionId);
    this.groups.set(sessionId, group);
    return { ...asset };
  }

  remove(sessionId: string): void {
    const group = this.groups.get(sessionId);
    if (group == null) return;
    this.groups.delete(sessionId);
    this.assetCount -= group.assets.size;
    this.urlBytes -= group.urlBytes;
  }

  clear(): void {
    this.groups.clear();
    this.assetCount = 0;
    this.urlBytes = 0;
  }

  private prune(): void {
    const now = Date.now();
    for (const [id, group] of this.groups) {
      if (group.expiresAt <= now) this.remove(id);
    }
  }

  private fullError(): Error & { statusCode: number } {
    return Object.assign(new Error("External stream manifest exceeds the asset budget."), {
      statusCode: 503,
    });
  }
}

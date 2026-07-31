import { useEffect, useMemo, useState } from "react";
import { EmptyState } from "../components/EmptyState";
import { Icon } from "../components/Icon";
import { getDownloadsBridge, type DownloadProgress } from "../lib/downloadsBridge";
import { isDesktopTauri, revealInFileManager } from "../lib/tauri";
import { getStore } from "../storage";
import { MediaItem as MediaItemNS } from "../models/media";
import type { DownloadRecord } from "../storage/models";
import { startDownloadsRuntime } from "../services/downloads";
import { useAppStore } from "../store/AppStore";
import "./LibraryScreens.css";
import "./DebridLibrary.css";
import "./Downloads.css";

function percent(record: DownloadRecord): number | null {
  if (record.status === "optimizing") {
    return record.optimizePercent == null ? null : record.optimizePercent;
  }
  if (record.bytesTotal == null || record.bytesTotal <= 0) return null;
  return Math.min(100, Math.round((record.bytesDone / record.bytesTotal) * 100));
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let n = value / 1024;
  let unit = 0;
  while (n >= 1024 && unit < units.length - 1) {
    n /= 1024;
    unit += 1;
  }
  return `${n >= 10 ? n.toFixed(0) : n.toFixed(1)} ${units[unit]}`;
}

function statusLabel(status: DownloadRecord["status"]): string {
  return status === "resolving" ? "Resolving" : `${status[0].toUpperCase()}${status.slice(1)}`;
}

function formatEta(seconds: number): string {
  if (seconds < 60) return "less than a minute";
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `about ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder === 0
    ? `about ${hours} hr`
    : `about ${hours} hr ${remainder} min`;
}

function progressLabel(record: DownloadRecord, speedBps?: number): string {
  const progress = percent(record);
  if (record.status === "optimizing") {
    const sourceSize = formatBytes(record.bytesTotal ?? record.bytesDone);
    return `Optimizing${progress == null ? "" : ` ${progress}%`} - ${sourceSize}`;
  }
  const amount =
    record.bytesTotal != null
      ? `${formatBytes(record.bytesDone)} / ${formatBytes(record.bytesTotal)}`
      : formatBytes(record.bytesDone);
  const speed = speedBps != null && speedBps > 0 ? ` · ${formatBytes(speedBps)}/s` : "";
  const eta =
    speedBps != null &&
    speedBps >= 100 * 1024 &&
    record.bytesTotal != null &&
    record.bytesTotal > record.bytesDone
      ? ` · ${formatEta((record.bytesTotal - record.bytesDone) / speedBps)} left`
      : "";
  return `${progress == null ? amount : `${progress}% · ${amount}`}${speed}${eta}`;
}

interface DownloadSeriesGroup {
  mediaId: string;
  title: string;
  seasons: Array<{ season: number | null; records: DownloadRecord[] }>;
}

/** Poster + backdrop for a queued title, resolved from the media cache. Both are
 * nullable: artwork is decorative, and a title can be queued before (or without)
 * its media ever being cached. */
export interface DownloadArtwork {
  poster: string | null;
  backdrop: string | null;
}
export type DownloadArtworkMap = Record<string, DownloadArtwork>;

/** The distinct media ids in a queue, in a stable order. The artwork effect keys
 * off this string so a progress tick - which replaces every record roughly once a
 * second - doesn't re-read the media cache. */
export function artworkKeyFor(records: DownloadRecord[]): string {
  return [...new Set(records.map((record) => record.mediaId))].sort().join(",");
}

/** Group the flat, durable queue for display only. The queue engine continues
 * to operate on its original flat records. */
export function groupDownloads(records: DownloadRecord[]): {
  movies: DownloadRecord[];
  series: DownloadSeriesGroup[];
} {
  const movies: DownloadRecord[] = [];
  const seriesByMediaId = new Map<string, DownloadRecord[]>();
  for (const record of records) {
    if (record.episodeId == null) movies.push(record);
    else {
      const group = seriesByMediaId.get(record.mediaId) ?? [];
      group.push(record);
      seriesByMediaId.set(record.mediaId, group);
    }
  }

  const series = [...seriesByMediaId.entries()].map(([mediaId, episodes]) => {
    const first = episodes[0]!;
    const title = first.title
      .replace(/\s+[Ss]\d{1,2}[Ee]\d{1,3}\b.*$/, "")
      .trim() || first.title;
    const seasonsByNumber = new Map<number | null, DownloadRecord[]>();
    for (const episode of episodes) {
      const season = episode.season;
      const seasonGroup = seasonsByNumber.get(season) ?? [];
      seasonGroup.push(episode);
      seasonsByNumber.set(season, seasonGroup);
    }
    const seasons = [...seasonsByNumber.entries()]
      .sort(([a], [b]) => {
        if (a == null) return 1;
        if (b == null) return -1;
        return a - b;
      })
      .map(([season, seasonRecords]) => ({
        season,
        records: [...seasonRecords].sort((a, b) => {
          if (a.episode == null && b.episode == null) return a.title.localeCompare(b.title);
          if (a.episode == null) return 1;
          if (b.episode == null) return -1;
          return a.episode - b.episode;
        }),
      }));
    return { mediaId, title, seasons };
  });

  return { movies, series };
}

/** A queued title's poster with its download progress drawn across the bottom of
 * the artwork. Falls back to a plain tile when the media cache has no poster.
 * Exported for test: the Downloads screen itself is behind a Tauri-only gate. */
export function DownloadPoster({
  art,
  title,
  progress,
  indeterminate,
  active,
}: {
  art?: DownloadArtwork;
  title: string;
  progress: number;
  /** True when the source size is unknown, so there is no denominator. The bar
   *  animates rather than sitting at a fake 0%. */
  indeterminate?: boolean;
  active: boolean;
}) {
  const poster = art?.poster ?? null;
  return (
    <span className="downloads-poster">
      {poster != null ? (
        <img src={poster} alt="" loading="lazy" draggable={false} />
      ) : (
        <span className="downloads-poster-ph" aria-hidden>
          <Icon name="library" size={14} />
        </span>
      )}
      <span
        className={`downloads-poster-bar${active ? " is-active" : ""}${indeterminate ? " is-indeterminate" : ""}`}
        role="progressbar"
        aria-valuenow={indeterminate ? undefined : progress}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`${title} download progress`}
      >
        <span style={indeterminate ? undefined : { width: `${progress}%` }} />
      </span>
    </span>
  );
}

/** Show header for a series group: the backdrop as a banner, with the poster and
 * title over it. Degrades to a plain heading when no artwork is cached.
 * Exported for test: the Downloads screen itself is behind a Tauri-only gate. */
export function DownloadShowBanner({ title, art }: { title: string; art?: DownloadArtwork }) {
  const backdrop = art?.backdrop ?? null;
  const poster = art?.poster ?? null;
  return (
    <div className={`downloads-show-banner${backdrop != null ? " has-backdrop" : ""}`}>
      {backdrop != null && (
        <img
          className="downloads-show-backdrop"
          src={backdrop}
          alt=""
          loading="lazy"
          draggable={false}
          aria-hidden
        />
      )}
      <div className="downloads-show-banner-inner">
        {poster != null ? (
          <img className="downloads-show-poster" src={poster} alt="" loading="lazy" draggable={false} />
        ) : (
          <span className="downloads-show-poster is-placeholder" aria-hidden>
            <Icon name="library" size={16} />
          </span>
        )}
        <h3 className="downloads-show-heading">{title}</h3>
      </div>
    </div>
  );
}

export function Downloads() {
  const { services, navigate, activeProfile, playLocalFile } = useAppStore();
  const tauri = isDesktopTauri();
  const [records, setRecords] = useState<DownloadRecord[]>([]);
  const [speeds, setSpeeds] = useState<Record<string, number>>({});
  const [ffmpegAvailable, setFfmpegAvailable] = useState<boolean | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!tauri) return;
    const store = getStore();
    const manager = startDownloadsRuntime(store, services.debrid);
    const unlistenRecords = manager.subscribeRecords(setRecords);
    const unlistenProgress = manager.subscribeProgress((progress: DownloadProgress) => {
      if (progress.speedBps == null) return;
      setSpeeds((previous) => ({ ...previous, [progress.jobId]: progress.speedBps! }));
    });
    void getDownloadsBridge()
      .downloadsFfmpegAvailable()
      .then(setFfmpegAvailable)
      .catch(() => setFfmpegAvailable(false));
    return () => {
      unlistenRecords();
      unlistenProgress();
    };
  }, [activeProfile?.id, services.debrid, tauri]);

  const selectedRecords = useMemo(
    () => records.filter((record) => selected.has(record.jobId)),
    [records, selected],
  );
  const groupedRecords = useMemo(() => groupDownloads(records), [records]);

  // Artwork for the queue, read from the media cache. Keyed on the distinct
  // media ids (not `records`) so streaming progress updates don't refetch.
  const [artwork, setArtwork] = useState<DownloadArtworkMap>({});
  const artworkKey = useMemo(() => artworkKeyFor(records), [records]);
  useEffect(() => {
    if (!tauri || artworkKey === "") return;
    let cancelled = false;
    void (async () => {
      const store = getStore();
      const next: DownloadArtworkMap = {};
      await Promise.all(
        artworkKey.split(",").map(async (mediaId) => {
          try {
            const cached = await store.getMedia(mediaId);
            if (cached?.item != null) {
              next[mediaId] = {
                poster: MediaItemNS.posterThumbnailURL(cached.item),
                backdrop: MediaItemNS.backdropThumbnailURL(cached.item),
              };
            }
          } catch {
            // Decorative only - a cache miss just leaves the fallback tile.
          }
        }),
      );
      if (!cancelled) setArtwork(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [artworkKey, tauri]);

  if (!tauri) {
    return (
      <div className="lib-screen">
        <h1 className="lib-h1">Downloads</h1>
        <EmptyState
          icon="debrid"
          title="Open the desktop app to download"
          subtitle="Browser builds can stream but cannot write debrid files to your device. Open YAWF Stream for desktop to queue and manage downloads."
          actions={
            <a
              className="btn btn-prominent"
              href="https://github.com/Tgk-30/YAWF-Stream/releases/latest"
              target="_blank"
              rel="noreferrer"
            >
              <Icon name="debrid" size={15} />
              Download desktop app
            </a>
          }
        />
      </div>
    );
  }

  const manager = startDownloadsRuntime(getStore(), services.debrid);
  const toggleSelected = (jobId: string) => {
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(jobId)) next.delete(jobId);
      else next.add(jobId);
      return next;
    });
  };
  const clearSelected = async () => {
    // Stop the native job BEFORE dropping its row. Deleting the row alone left
    // the transfer (or ffmpeg transcode) running at full speed with nothing left
    // to stop it - the row carried the only Force stop button, and its destPath
    // went with the record, orphaning the part-file. forceStop no-ops on
    // terminal rows, so this is safe for the whole selection.
    await Promise.all(
      selectedRecords.map(async (record) => {
        await manager.forceStop(record.jobId);
        await getStore().deleteDownload(record.jobId);
      }),
    );
    setSelected(new Set());
  };

  return (
    <div className="lib-screen downloads-screen">
      <div className="dl-head">
        <div>
          <h1 className="lib-h1">Downloads</h1>
          <p className="lib-sub t-secondary">
            Downloads run on this desktop and continue in the background while the app is open.
          </p>
        </div>
        <button type="button" className="btn" onClick={() => navigate("settings")}>
          <Icon name="settings" size={15} />
          Folder settings
        </button>
      </div>

      {ffmpegAvailable === false && (
        <p className="downloads-note t-secondary">
          Optimized downloads are unavailable because FFmpeg was not found. Full-size downloads still work.
        </p>
      )}

      {selectedRecords.length > 0 && (
        <div className="dl-bulkbar glass-raised glass-lit">
          <span>{selectedRecords.length} selected</span>
          <button type="button" className="btn dl-delete" onClick={() => void clearSelected()}>
            <Icon name="trash" size={15} />
            Remove selected
          </button>
        </div>
      )}

      {records.length === 0 ? (
        <EmptyState
          icon="debrid"
          title="Your download queue is empty"
          subtitle="Choose Download from a movie or episode to save it to this desktop."
        />
      ) : (
        <div className="downloads-groups">
          {groupedRecords.movies.length > 0 && (
            <DownloadSection
              heading="Movies"
              records={groupedRecords.movies}
              selected={selected}
              toggleSelected={toggleSelected}
              speeds={speeds}
              manager={manager}
              artwork={artwork}
              playLocalFile={playLocalFile}
            />
          )}
          {groupedRecords.series.length > 0 && (
            <section className="downloads-series-section" aria-labelledby="downloads-series-heading">
              <h2 id="downloads-series-heading" className="downloads-section-heading">Series</h2>
              {groupedRecords.series.map((series) => (
                <section key={series.mediaId} className="downloads-show-section" aria-label={series.title}>
                  <DownloadShowBanner title={series.title} art={artwork[series.mediaId]} />
                  {series.seasons.map(({ season, records: seasonRecords }) => (
                    <DownloadSection
                      key={season ?? "unassigned"}
                      heading={season == null ? "Episodes" : `Season ${season}`}
                      nested
                      records={seasonRecords}
                      selected={selected}
                      toggleSelected={toggleSelected}
                      speeds={speeds}
                      manager={manager}
                      artwork={artwork}
                      playLocalFile={playLocalFile}
                    />
                  ))}
                </section>
              ))}
            </section>
          )}
        </div>
      )}
    </div>
  );
}

function DownloadSection({
  heading,
  nested = false,
  records,
  selected,
  toggleSelected,
  speeds,
  manager,
  artwork,
  playLocalFile,
}: {
  heading: string;
  nested?: boolean;
  records: DownloadRecord[];
  selected: Set<string>;
  toggleSelected: (jobId: string) => void;
  speeds: Record<string, number>;
  manager: ReturnType<typeof startDownloadsRuntime>;
  artwork: DownloadArtworkMap;
  playLocalFile: (path: string, title: string) => void;
}) {
  return (
    <section className={`downloads-section${nested ? " is-nested" : ""}`}>
      {nested ? <h4 className="downloads-season-heading">{heading}</h4> : <h2 className="downloads-section-heading">{heading}</h2>}
      <div className="dl-table glass-rest glass-lit downloads-table">
        <div className="downloads-row downloads-row-head">
          <span className="dl-col-check" />
          <span className="dl-col-art" />
          <span>Title</span>
          <span>Mode</span>
          <span>Progress</span>
          <span>Status</span>
          <span className="dl-col-actions" />
        </div>
        {records.map((record) => {
          const knownProgress = percent(record);
          const progress = knownProgress ?? 0;
          const canPause = ["resolving", "downloading", "optimizing"].includes(record.status);
          const canResume = record.status === "paused";
          const canRetry = record.status === "failed";
          const canForceStop = !["completed", "canceled"].includes(record.status);
          // A completed record's destination is the durable proof of the local
          // file we created. Do not offer either action for partial/failed rows
          // (or legacy completed records that lack a path).
          const canOpenLocalFile = record.status === "completed" && record.destPath != null;
          return (
            <div key={record.jobId} className="downloads-row">
              <span className="dl-col-check">
                <input
                  type="checkbox"
                  checked={selected.has(record.jobId)}
                  onChange={() => toggleSelected(record.jobId)}
                  aria-label={`Select ${record.title}`}
                />
              </span>
              <DownloadPoster
                art={artwork[record.mediaId]}
                title={record.title}
                progress={progress}
                indeterminate={
                  knownProgress == null &&
                  (record.status === "downloading" || record.status === "optimizing")
                }
                active={!["completed", "canceled", "failed"].includes(record.status)}
              />
              <span className="downloads-title" title={record.title}>
                <strong>{record.title}</strong>
                {record.error != null && <small className="dl-error">{record.error}</small>}
              </span>
              <span className="downloads-mode">
                {record.mode === "optimized"
                  ? `Optimized · ${record.optimizeProfile ?? "remux"}`
                  : "Full size"}
              </span>
              {/* The bar itself now lives on the poster; this column keeps the
                  numbers, which the bar alone can't convey. */}
              <span className="downloads-progress">
                <small>{progressLabel(record, speeds[record.jobId] ?? manager.speedFor(record.jobId))}</small>
              </span>
              <span>
                <span className={`dl-status-pill downloads-status-${record.status}`}>
                  {statusLabel(record.status)}
                </span>
              </span>
              <span className="downloads-actions">
                {canOpenLocalFile && (
                  <button
                    type="button"
                    className="dl-icon-btn"
                    onClick={() => playLocalFile(record.destPath!, record.title)}
                    aria-label={`Play ${record.title}`}
                    title="Play"
                  >
                    <Icon name="play" size={14} />
                  </button>
                )}
                {canOpenLocalFile && (
                  <button
                    type="button"
                    className="dl-icon-btn"
                    onClick={() => void revealInFileManager(record.destPath!)}
                    aria-label={`Reveal ${record.title} in folder`}
                    title="Reveal in folder"
                  >
                    <Icon name="folder" size={15} />
                  </button>
                )}
                {canPause && (
                  <button type="button" className="dl-icon-btn" onClick={() => void manager.pause(record.jobId)} aria-label={`Pause ${record.title}`} title="Pause">
                    Ⅱ
                  </button>
                )}
                {canResume && (
                  <button type="button" className="dl-icon-btn" onClick={() => void manager.resume(record.jobId)} aria-label={`Resume ${record.title}`} title="Resume">
                    <Icon name="play" size={14} />
                  </button>
                )}
                {canRetry && (
                  <button
                    type="button"
                    className="dl-icon-btn"
                    onClick={() => void manager.retry(record.jobId)}
                    aria-label={`Retry ${record.title}`}
                    title="Retry"
                  >
                    <Icon name="refresh" size={14} />
                  </button>
                )}
                {canOpenLocalFile && (
                  <button
                    type="button"
                    className="dl-icon-btn downloads-cancel"
                    onClick={() => {
                      if (
                        window.confirm(
                          `Delete the downloaded file for ${record.title}? This cannot be undone.`,
                        )
                      ) {
                        void manager.deleteCompletedFile(record.jobId);
                      }
                    }}
                    aria-label={`Delete downloaded file for ${record.title}`}
                    title="Delete file"
                  >
                    <Icon name="trash" size={14} />
                  </button>
                )}
                {canForceStop && (
                  <button
                    type="button"
                    className="dl-icon-btn downloads-cancel"
                    onClick={() => {
                      const progress = percent(record) ?? 0;
                      if (
                        progress < 10 ||
                        window.confirm(
                          `Stop ${record.title} and delete its partial file? This cannot be undone.`,
                        )
                      ) {
                        void manager.forceStop(record.jobId);
                      }
                    }}
                    aria-label={`Stop ${record.title} and delete partial file`}
                    title="Stop & delete partial"
                  >
                    <Icon name="xmark" size={15} />
                  </button>
                )}
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

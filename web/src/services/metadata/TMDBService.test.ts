// Mirrors the Swift TMDBService tests:
//  - Tests/.../TMDBServiceNetworkTests.swift (request shape, 401 mapping)
//  - Tests/.../TMDBCacheAndCreditsTests.swift (getCast, getRecommendations, TTL cache)
//  - Tests/.../TMDBServiceTests.swift (toMediaPreview / toMediaItem mapping)
//
// The Swift tests stub the network with a MockURLProtocol handler keyed per
// session, counting hits to prove a memoized read issues exactly one request.
// Here we inject a `FetchImpl` stub that plays the same role: it captures the
// requested URL and counts calls.

import { afterEach, describe, expect, it } from "vitest";
import { type FetchImpl, TMDBService } from "./TMDBService";
import { NetworkBlockedError, setNetworkMode } from "../../lib/networkPolicy";

afterEach(() => setNetworkMode("standard"));

// MARK: - fetch stub (mirrors MockURLProtocol + makeMockSession)

interface MockResponse {
  status: number;
  body: string;
}

interface MockFetch {
  fetchImpl: FetchImpl;
  /** The last URL requested, parsed. */
  lastURL: () => URL | null;
  /** Number of times the stub was invoked. */
  hits: () => number;
}

/** Builds a fetch stub from a handler `(url) => MockResponse`. */
function makeMockFetch(handler: (url: URL) => MockResponse): MockFetch {
  let count = 0;
  let captured: URL | null = null;
  const fetchImpl: FetchImpl = async (url) => {
    count += 1;
    const parsed = new URL(url);
    captured = parsed;
    const { status, body } = handler(parsed);
    return {
      status,
      text: async () => body,
    };
  };
  return {
    fetchImpl,
    lastURL: () => captured,
    hits: () => count,
  };
}

const ok = (body: string): MockResponse => ({ status: 200, body });
const serverError = (body: string): MockResponse => ({ status: 500, body });

describe("TMDBService privacy gate", () => {
  it("throws NetworkBlockedError in Offline mode before requesting metadata", async () => {
    const mock = makeMockFetch(() => ok(searchBody));
    const service = new TMDBService("key", mock.fetchImpl);
    setNetworkMode("offline");

    await expect(service.search("Fight Club", "movie")).rejects.toBeInstanceOf(
      NetworkBlockedError,
    );
    expect(mock.hits()).toBe(0);
  });

  it("requests metadata in Standard mode", async () => {
    const mock = makeMockFetch(() => ok(searchBody));
    const service = new TMDBService("key", mock.fetchImpl);

    await expect(service.search("Fight Club", "movie")).resolves.toMatchObject({
      items: expect.any(Array),
    });
    expect(mock.hits()).toBe(1);
  });
});

describe("TMDBService locale", () => {
  it("applies the configured language and region to catalog requests", async () => {
    const mock = makeMockFetch(() => ok(searchBody));
    const service = new TMDBService("key", mock.fetchImpl, {
      language: "pt-BR",
      region: "BR",
    });
    await service.search("Cidade de Deus", "movie");
    expect(mock.lastURL()?.searchParams.get("language")).toBe("pt-BR");
    expect(mock.lastURL()?.searchParams.get("region")).toBe("BR");
  });
});

/** A fetch stub that dispatches per-path so a single service can answer the
 * multi-request flows (getDetail-via-find, etc.). Routes on URL.pathname. */
function makeRoutedFetch(routes: Record<string, MockResponse>): MockFetch {
  let count = 0;
  let captured: URL | null = null;
  const fetchImpl: FetchImpl = async (url) => {
    count += 1;
    const parsed = new URL(url);
    captured = parsed;
    const route = routes[parsed.pathname];
    if (route == null) {
      throw new Error(`no route for ${parsed.pathname}`);
    }
    return { status: route.status, text: async () => route.body };
  };
  return { fetchImpl, lastURL: () => captured, hits: () => count };
}

// MARK: - Canned JSON (same shapes as the Swift tests)

const searchBody = JSON.stringify({
  page: 1,
  results: [
    {
      id: 550,
      title: "Fight Club",
      media_type: "movie",
      overview: "desc",
      poster_path: "/fc.jpg",
      backdrop_path: "/fc-backdrop.jpg",
      release_date: "1999-10-15",
      vote_average: 8.4,
    },
  ],
  total_pages: 1,
  total_results: 1,
});

const creditsBody = JSON.stringify({
  id: 550,
  cast: [
    {
      id: 819,
      name: "Edward Norton",
      character: "The Narrator",
      profile_path: "/norton.jpg",
    },
    {
      id: 287,
      name: "Brad Pitt",
      character: "Tyler Durden",
      profile_path: "/pitt.jpg",
    },
  ],
});

const recommendationsBody = JSON.stringify({
  page: 1,
  results: [
    {
      id: 807,
      title: "Se7en",
      media_type: "movie",
      overview: "Two detectives hunt a serial killer.",
      poster_path: "/se7en.jpg",
      release_date: "1995-09-22",
      vote_average: 8.4,
    },
    {
      id: 1422,
      title: "The Departed",
      media_type: "movie",
      overview: "An undercover cop and a mole.",
      poster_path: "/departed.jpg",
      release_date: "2006-10-06",
      vote_average: 8.2,
    },
  ],
  total_pages: 1,
  total_results: 2,
});

const movieDetailBody = JSON.stringify({
  id: 12345,
  title: "Test Movie",
  overview: "Great movie",
  poster_path: "/poster.jpg",
  backdrop_path: "/backdrop.jpg",
  release_date: "2024-06-15",
  vote_average: 8.5,
  runtime: 142,
  status: "Released",
  genres: [
    { id: 28, name: "Action" },
    { id: 35, name: "Comedy" },
  ],
  external_ids: { imdb_id: "tt1234567", tvdb_id: null },
});

const tvDetailBody = JSON.stringify({
  id: 54321,
  name: "Test Show",
  overview: "Good show",
  first_air_date: "2023-03-20",
  vote_average: 9.1,
  episode_run_time: [45],
  status: "Returning Series",
  genres: [{ id: 18, name: "Drama" }],
  external_ids: { imdb_id: null, tvdb_id: null },
});

// MARK: - Network request shape + decoding (TMDBServiceNetworkTests)

describe("TMDBService search", () => {
  it("builds correct query parameters and decodes results (incl. backdropPath)", async () => {
    const mock = makeMockFetch(() => ok(searchBody));
    const service = new TMDBService("tmdb-key", mock.fetchImpl);

    const result = await service.search("fight club", "movie", 1);

    expect(result.items.length).toBe(1);
    expect(result.items[0].title).toBe("Fight Club");
    expect(result.items[0].type).toBe("movie");
    expect(result.items[0].year).toBe(1999);
    expect(result.items[0].tmdbId).toBe(550);
    expect(result.items[0].posterPath).toBe("/fc.jpg");
    expect(result.items[0].backdropPath).toBe("/fc-backdrop.jpg");
    expect(result.items[0].imdbRating).toBe(8.4);

    const url = mock.lastURL();
    expect(url).not.toBeNull();
    expect(url!.pathname).toBe("/3/search/movie");
    const query = url!.search;
    expect(query).toContain("query=fight+club");
    expect(query).toContain("api_key=tmdb-key");
    expect(query).toContain("include_adult=false");
    expect(query).toContain("page=1");
  });

  it("maps HTTP 401 to an unauthorized error", async () => {
    const mock = makeMockFetch(() => ({ status: 401, body: "{}" }));
    const service = new TMDBService("bad-key", mock.fetchImpl);

    await expect(service.search("test", "movie", 1)).rejects.toMatchObject({
      kind: "unauthorized",
    });
  });
});

// MARK: - getTrending / getCategory / discover decode into MediaPreview

describe("TMDBService catalog reads decode into MediaPreview", () => {
  it("getTrending hits the trending path and decodes previews", async () => {
    const mock = makeMockFetch(() => ok(searchBody));
    const service = new TMDBService("tmdb-key", mock.fetchImpl);

    const result = await service.getTrending("movie", "week", 1);
    expect(result.items[0].backdropPath).toBe("/fc-backdrop.jpg");
    expect(mock.lastURL()!.pathname).toBe("/3/trending/movie/week");
  });

  it("getCategory hits the category path", async () => {
    const mock = makeMockFetch(() => ok(searchBody));
    const service = new TMDBService("tmdb-key", mock.fetchImpl);

    await service.getCategory("top_rated", "movie", 1);
    expect(mock.lastURL()!.pathname).toBe("/3/movie/top_rated");
  });

  it("builds a cached, release-dated movie calendar from now-playing and upcoming", async () => {
    const mock = makeRoutedFetch({
      "/3/movie/now_playing": ok(JSON.stringify({
        page: 1,
        results: [
          { id: 1, title: "Recent Movie", release_date: "2026-06-10" },
          { id: 2, title: "No Date" },
        ],
        total_pages: 1,
        total_results: 2,
      })),
      "/3/movie/upcoming": ok(JSON.stringify({
        page: 1,
        results: [
          { id: 3, title: "Future Movie", release_date: "2026-07-04" },
        ],
        total_pages: 1,
        total_results: 1,
      })),
    });
    const service = new TMDBService("tmdb-key", mock.fetchImpl);

    const first = await service.getMovieReleaseCalendar();
    expect(first).toEqual([
      expect.objectContaining({ releaseDate: "2026-06-10", source: "now_playing" }),
      expect.objectContaining({ releaseDate: "2026-07-04", source: "upcoming" }),
    ]);
    expect(mock.hits()).toBe(2);

    expect(await service.getMovieReleaseCalendar()).toEqual(first);
    expect(mock.hits()).toBe(2);
  });

  it("returns [] without throwing when a category response has no results array", async () => {
    // TMDB unreachable / missing key / error shape: response lacks `.results`.
    // The calendar must degrade to empty, not crash on `.results.flatMap`.
    const mock = makeRoutedFetch({
      "/3/movie/now_playing": ok(JSON.stringify({ success: false, status_message: "invalid" })),
      "/3/movie/upcoming": ok(JSON.stringify({})),
    });
    const service = new TMDBService("tmdb-key", mock.fetchImpl);
    await expect(service.getMovieReleaseCalendar()).resolves.toEqual([]);
  });

  it("discover applies filters and hits the discover path", async () => {
    const mock = makeMockFetch(() => ok(searchBody));
    const service = new TMDBService("tmdb-key", mock.fetchImpl);

    await service.discover("movie", {
      genreId: 28,
      year: 1999,
      minRating: 8,
      sortBy: "vote_average.desc",
      page: 2,
    });

    const url = mock.lastURL()!;
    expect(url.pathname).toBe("/3/discover/movie");
    expect(url.searchParams.get("with_genres")).toBe("28");
    expect(url.searchParams.get("primary_release_year")).toBe("1999");
    expect(url.searchParams.get("vote_average.gte")).toBe("8");
    expect(url.searchParams.get("vote_count.gte")).toBe("100");
    expect(url.searchParams.get("sort_by")).toBe("vote_average.desc");
    expect(url.searchParams.get("page")).toBe("2");
  });

  it("discoverWithParams forwards a raw param map to the discover path", async () => {
    const mock = makeMockFetch(() => ok(searchBody));
    const service = new TMDBService("tmdb-key", mock.fetchImpl);

    const result = await service.discoverWithParams("series", {
      page: "3",
      sort_by: "popularity.desc",
      with_genres: "18,80",
      "first_air_date.gte": "2015-01-01",
      "vote_count.gte": "500",
      with_original_language: "ko",
    });

    const url = mock.lastURL()!;
    expect(url.pathname).toBe("/3/discover/tv");
    expect(url.searchParams.get("with_genres")).toBe("18,80");
    expect(url.searchParams.get("first_air_date.gte")).toBe("2015-01-01");
    expect(url.searchParams.get("vote_count.gte")).toBe("500");
    expect(url.searchParams.get("with_original_language")).toBe("ko");
    expect(url.searchParams.get("page")).toBe("3");
    expect(result.items).toHaveLength(1);
  });

  it("discoverWithParams memoizes identical param maps", async () => {
    const mock = makeMockFetch(() => ok(searchBody));
    const service = new TMDBService("tmdb-key", mock.fetchImpl);

    const params = { page: "1", sort_by: "popularity.desc", with_genres: "28" };
    await service.discoverWithParams("movie", params);
    await service.discoverWithParams("movie", { ...params });
    expect(mock.hits()).toBe(1);
  });
});

// MARK: - getDetail mapping (TMDBDetailResponseTests + getDetail path)

describe("TMDBService getDetail", () => {
  it("maps a movie detail into MediaItem using the IMDB id, runtime, genres", async () => {
    const mock = makeMockFetch(() => ok(movieDetailBody));
    const service = new TMDBService("tmdb-key", mock.fetchImpl);

    const item = await service.getDetail("tmdb-12345", "movie");

    expect(item.id).toBe("tt1234567"); // Uses IMDB ID
    expect(item.title).toBe("Test Movie");
    expect(item.year).toBe(2024);
    expect(item.runtime).toBe(142);
    expect(item.genres).toEqual(["Action", "Comedy"]);
    expect(item.imdbRating).toBe(8.5);
    expect(item.tmdbId).toBe(12345);
    expect(item.backdropPath).toBe("/backdrop.jpg");

    const url = mock.lastURL()!;
    expect(url.pathname).toBe("/3/movie/12345");
    expect(url.searchParams.get("append_to_response")).toBe("external_ids");
  });

  it("falls back to tmdb-{id} when there is no IMDB id, and uses episode runtime for TV", async () => {
    const mock = makeMockFetch(() => ok(tvDetailBody));
    const service = new TMDBService("tmdb-key", mock.fetchImpl);

    const item = await service.getDetail("54321", "series");

    expect(item.id).toBe("tmdb-54321"); // no imdb id -> tmdb fallback
    expect(item.runtime).toBe(45); // episode_run_time[0]
    expect(item.year).toBe(2023);
    expect(item.status).toBe("Returning Series");
    expect(mock.lastURL()!.pathname).toBe("/3/tv/54321");
  });
});

// MARK: - getCast decoding (TMDBServiceGetCastTests)

describe("TMDBService getCast", () => {
  it("decodes cast name/character and builds the w185 profile URL", async () => {
    const mock = makeMockFetch(() => ok(creditsBody));
    const service = new TMDBService("tmdb-key", mock.fetchImpl);

    const cast = await service.getCast(550, "movie");

    expect(cast.length).toBe(2);
    expect(cast[0].id).toBe(819);
    expect(cast[0].name).toBe("Edward Norton");
    expect(cast[0].character).toBe("The Narrator");
    expect(cast[0].profileURL).toBe(
      "https://image.tmdb.org/t/p/w185/norton.jpg",
    );
    expect(cast[1].name).toBe("Brad Pitt");
    expect(cast[1].character).toBe("Tyler Durden");
    expect(cast[1].profileURL).toBe("https://image.tmdb.org/t/p/w185/pitt.jpg");

    expect(mock.lastURL()!.pathname).toBe("/3/movie/550/credits");
  });

  it("maps a missing character to '' and a null profile to a null URL", async () => {
    const body = JSON.stringify({
      id: 1399,
      cast: [{ id: 12, name: "No Character Actor", profile_path: null }],
    });
    const mock = makeMockFetch(() => ok(body));
    const service = new TMDBService("tmdb-key", mock.fetchImpl);

    const cast = await service.getCast(1399, "series");

    expect(cast[0].character).toBe("");
    expect(cast[0].profileURL).toBeNull();
  });

  it("uses the tv path segment for series", async () => {
    const mock = makeMockFetch(() => ok(JSON.stringify({ id: 1399, cast: [] })));
    const service = new TMDBService("tmdb-key", mock.fetchImpl);

    const cast = await service.getCast(1399, "series");

    expect(cast.length).toBe(0);
    expect(mock.lastURL()!.pathname).toBe("/3/tv/1399/credits");
  });
});

// MARK: - getRecommendations decoding (TMDBServiceGetRecommendationsTests)

describe("TMDBService getRecommendations", () => {
  it("decodes paged results into a MediaPreview list", async () => {
    const mock = makeMockFetch(() => ok(recommendationsBody));
    const service = new TMDBService("tmdb-key", mock.fetchImpl);

    const previews = await service.getRecommendations(550, "movie");

    expect(previews.length).toBe(2);
    expect(previews[0].id).toBe("tmdb-807");
    expect(previews[0].tmdbId).toBe(807);
    expect(previews[0].title).toBe("Se7en");
    expect(previews[0].type).toBe("movie");
    expect(previews[0].year).toBe(1995);
    expect(previews[0].posterPath).toBe("/se7en.jpg");
    expect(previews[0].imdbRating).toBe(8.4);
    expect(previews[1].title).toBe("The Departed");
    expect(previews[1].year).toBe(2006);

    const url = mock.lastURL()!;
    expect(url.pathname).toBe("/3/movie/550/recommendations");
    expect(url.search).toContain("page=1");
  });
});

// MARK: - TTL response cache (TMDBServiceResponseCacheTests)

describe("TMDBService TTL response cache", () => {
  it("getCast memoizes within TTL - second read served from cache, no extra network hit", async () => {
    // First hit returns valid credits; any subsequent hit returns a 500 that
    // would throw if a second network read actually occurred.
    const mock = makeMockFetch(() =>
      mock.hits() === 1 ? ok(creditsBody) : serverError('{"error":"boom"}'),
    );
    const service = new TMDBService("tmdb-key", mock.fetchImpl);

    const first = await service.getCast(550, "movie");
    expect(first.length).toBe(2);
    expect(mock.hits()).toBe(1);

    const second = await service.getCast(550, "movie");
    expect(second).toEqual(first);
    expect(mock.hits()).toBe(1); // NOT hit a second time
    expect(second[0].name).toBe("Edward Norton");
  });

  it("getRecommendations memoizes within TTL - cached value persists when stub later errors", async () => {
    const mock = makeMockFetch(() =>
      mock.hits() === 1 ? ok(recommendationsBody) : serverError("{}"),
    );
    const service = new TMDBService("tmdb-key", mock.fetchImpl);

    const first = await service.getRecommendations(550, "movie");
    expect(first.length).toBe(2);
    expect(mock.hits()).toBe(1);

    const second = await service.getRecommendations(550, "movie");
    expect(second).toEqual(first);
    expect(mock.hits()).toBe(1);
    expect(second[0].title).toBe("Se7en");
  });

  it("is keyed per request - distinct tmdbIds each hit the network", async () => {
    const mock = makeMockFetch(() => ok(JSON.stringify({ id: 0, cast: [] })));
    const service = new TMDBService("tmdb-key", mock.fetchImpl);

    await service.getCast(1, "movie");
    await service.getCast(2, "movie");
    expect(mock.hits()).toBe(2); // two distinct keys -> two hits

    await service.getCast(1, "movie");
    expect(mock.hits()).toBe(2); // repeat of first id served from cache
  });

  it("genres use a long TTL and are also memoized", async () => {
    const genresBody = JSON.stringify({
      genres: [
        { id: 28, name: "Action" },
        { id: 35, name: "Comedy" },
      ],
    });
    const mock = makeMockFetch(() =>
      mock.hits() === 1 ? ok(genresBody) : serverError("{}"),
    );
    const service = new TMDBService("tmdb-key", mock.fetchImpl);

    const first = await service.getGenres("movie");
    expect(first).toEqual([
      { id: 28, name: "Action" },
      { id: 35, name: "Comedy" },
    ]);
    expect(mock.lastURL()!.pathname).toBe("/3/genre/movie/list");

    const second = await service.getGenres("movie");
    expect(second).toEqual(first);
    expect(mock.hits()).toBe(1);
  });
});

// MARK: - search with type=null (multi path) + preview mapping edge cases

describe("TMDBService search type=null (multi)", () => {
  it("uses /search/multi and adds the language param when type is null", async () => {
    const mock = makeMockFetch(() => ok(searchBody));
    const service = new TMDBService("tmdb-key", mock.fetchImpl);

    await service.search("anything", null, 1);

    const url = mock.lastURL()!;
    expect(url.pathname).toBe("/3/search/multi");
    expect(url.searchParams.get("language")).toBe("en-US");
    expect(url.searchParams.get("include_adult")).toBe("false");
  });

  it("adds the configured language param for a typed search", async () => {
    const mock = makeMockFetch(() => ok(searchBody));
    const service = new TMDBService("tmdb-key", mock.fetchImpl);

    await service.search("anything", "series", 1);

    const url = mock.lastURL()!;
    expect(url.pathname).toBe("/3/search/tv");
    expect(url.searchParams.get("language")).toBe("en-US");
  });

  it("drops person results and entries with no title, and infers type from title/name", async () => {
    const body = JSON.stringify({
      page: 1,
      results: [
        // person -> dropped
        { id: 1, name: "Some Actor", media_type: "person" },
        // empty title -> dropped
        { id: 2, title: "", media_type: "movie" },
        // no media_type, has title -> movie
        { id: 3, title: "Inferred Movie", release_date: "2001-05-01" },
        // no media_type, only name -> series
        { id: 4, name: "Inferred Show", first_air_date: "2010-01-01" },
      ],
      total_pages: 5,
      total_results: 97,
    });
    const mock = makeMockFetch(() => ok(body));
    const service = new TMDBService("tmdb-key", mock.fetchImpl);

    const result = await service.search("mixed", null, 1);

    expect(result.items).toHaveLength(2);
    expect(result.items[0].id).toBe("tmdb-3");
    expect(result.items[0].type).toBe("movie");
    expect(result.items[0].year).toBe(2001);
    expect(result.items[1].id).toBe("tmdb-4");
    expect(result.items[1].type).toBe("series");
    expect(result.items[1].year).toBe(2010);
    // pagination is carried through verbatim
    expect(result.page).toBe(1);
    expect(result.totalPages).toBe(5);
    expect(result.totalResults).toBe(97);
  });

  it("treats a too-short date string (<4 chars) and a non-numeric year as null", async () => {
    const body = JSON.stringify({
      page: 1,
      results: [
        { id: 9, title: "Short Date", media_type: "movie", release_date: "99" },
        { id: 10, title: "Junk Date", media_type: "movie", release_date: "abcd-01-01" },
      ],
      total_pages: 1,
      total_results: 2,
    });
    const mock = makeMockFetch(() => ok(body));
    const service = new TMDBService("tmdb-key", mock.fetchImpl);

    const result = await service.search("dates", "movie", 1);
    expect(result.items[0].year).toBeNull();
    expect(result.items[1].year).toBeNull();
  });

  it("maps missing optional fields to null (poster/backdrop/rating)", async () => {
    const body = JSON.stringify({
      page: 1,
      results: [{ id: 11, title: "Bare", media_type: "movie" }],
      total_pages: 1,
      total_results: 1,
    });
    const mock = makeMockFetch(() => ok(body));
    const service = new TMDBService("tmdb-key", mock.fetchImpl);

    const result = await service.search("bare", "movie", 1);
    const item = result.items[0];
    expect(item.posterPath).toBeNull();
    expect(item.backdropPath).toBeNull();
    expect(item.imdbRating).toBeNull();
    expect(item.year).toBeNull();
  });
});

// MARK: - HTTP error mapping (404 / 429 / generic httpError + malformed JSON)

describe("TMDBService HTTP error mapping", () => {
  it("maps 404 to a notFound error carrying the request path", async () => {
    const mock = makeMockFetch(() => ({ status: 404, body: "{}" }));
    const service = new TMDBService("tmdb-key", mock.fetchImpl);

    await expect(service.getCast(550, "movie")).rejects.toMatchObject({
      kind: "notFound",
    });
  });

  it("maps 429 to a rateLimited error", async () => {
    const mock = makeMockFetch(() => ({ status: 429, body: "{}" }));
    const service = new TMDBService("tmdb-key", mock.fetchImpl);

    await expect(service.getTrending("movie", "week", 1)).rejects.toMatchObject(
      { kind: "rateLimited" },
    );
  });

  it("maps an unhandled non-2xx status to httpError with the status code and body", async () => {
    const mock = makeMockFetch(() => ({ status: 503, body: "service down" }));
    const service = new TMDBService("tmdb-key", mock.fetchImpl);

    await expect(
      service.getCategory("popular", "movie", 1),
    ).rejects.toMatchObject({
      kind: "httpError",
      statusCode: 503,
      message: "TMDB HTTP 503: service down",
    });
  });

  it("propagates a JSON parse failure for a 2xx body that is not valid JSON", async () => {
    const mock = makeMockFetch(() => ok("not json at all"));
    const service = new TMDBService("tmdb-key", mock.fetchImpl);

    await expect(service.getCast(1, "movie")).rejects.toThrow();
  });

  it("does not cache a failed read - a later success is fetched and served", async () => {
    // First call 500s (not cached), second call returns valid genres.
    const genresBody = JSON.stringify({ genres: [{ id: 1, name: "Action" }] });
    const mock = makeMockFetch(() =>
      mock.hits() === 1 ? serverError("boom") : ok(genresBody),
    );
    const service = new TMDBService("tmdb-key", mock.fetchImpl);

    await expect(service.getGenres("movie")).rejects.toMatchObject({
      kind: "httpError",
    });
    const second = await service.getGenres("movie");
    expect(second).toEqual([{ id: 1, name: "Action" }]);
    expect(mock.hits()).toBe(2);
  });
});

// MARK: - getDetail IMDB-id resolution + runtime fallbacks

describe("TMDBService getDetail id resolution", () => {
  it("resolves an IMDB id via /find first, then fetches the detail", async () => {
    const findBody = JSON.stringify({
      movie_results: [{ id: 777 }],
      tv_results: [],
    });
    const detailBody = JSON.stringify({
      id: 777,
      title: "Found Movie",
      release_date: "2018-02-02",
      external_ids: { imdb_id: "tt0099999", tvdb_id: null },
    });
    const mock = makeRoutedFetch({
      "/3/find/tt0099999": ok(findBody),
      "/3/movie/777": ok(detailBody),
    });
    const service = new TMDBService("tmdb-key", mock.fetchImpl);

    const item = await service.getDetail("tt0099999", "movie");
    expect(item.id).toBe("tt0099999");
    expect(item.tmdbId).toBe(777);
    expect(item.title).toBe("Found Movie");
    expect(mock.hits()).toBe(2);
    expect(mock.lastURL()!.pathname).toBe("/3/movie/777");
  });

  it("throws notFound when /find returns no matching result for the type", async () => {
    const findBody = JSON.stringify({ movie_results: [], tv_results: [] });
    const mock = makeRoutedFetch({ "/3/find/tt0000000": ok(findBody) });
    const service = new TMDBService("tmdb-key", mock.fetchImpl);

    await expect(service.getDetail("tt0000000", "movie")).rejects.toMatchObject(
      { kind: "notFound" },
    );
  });

  it("maps runtime=0 to null (no positive runtime nor episode_run_time)", async () => {
    const detailBody = JSON.stringify({
      id: 5,
      title: "Zero Runtime",
      runtime: 0,
      episode_run_time: [0],
      external_ids: { imdb_id: "", tvdb_id: null },
    });
    const mock = makeMockFetch(() => ok(detailBody));
    const service = new TMDBService("tmdb-key", mock.fetchImpl);

    const item = await service.getDetail("tmdb-5", "movie");
    // empty imdb_id falls through to tmdb-{id}
    expect(item.id).toBe("tmdb-5");
    expect(item.runtime).toBeNull();
    expect(item.genres).toEqual([]);
    expect(item.overview).toBeNull();
    expect(item.year).toBeNull();
  });

  it("uses 'Unknown' title and null backdrop when the detail has neither title nor name", async () => {
    const detailBody = JSON.stringify({ id: 6 });
    const mock = makeMockFetch(() => ok(detailBody));
    const service = new TMDBService("tmdb-key", mock.fetchImpl);

    const item = await service.getDetail("6", "movie");
    expect(item.title).toBe("Unknown");
    expect(item.backdropPath).toBeNull();
    expect(item.imdbRating).toBeNull();
    expect(item.status).toBeNull();
  });
});

// MARK: - findByImdbId branches

describe("TMDBService findByImdbId", () => {
  it("returns the first movie result id for a movie lookup", async () => {
    const body = JSON.stringify({
      movie_results: [{ id: 42 }, { id: 99 }],
      tv_results: [{ id: 7 }],
    });
    const mock = makeMockFetch(() => ok(body));
    const service = new TMDBService("tmdb-key", mock.fetchImpl);

    const id = await service.findByImdbId("tt1", "movie");
    expect(id).toBe(42);
    expect(mock.lastURL()!.pathname).toBe("/3/find/tt1");
    expect(mock.lastURL()!.searchParams.get("external_source")).toBe("imdb_id");
  });

  it("returns the first tv result id for a series lookup", async () => {
    const body = JSON.stringify({
      movie_results: [{ id: 42 }],
      tv_results: [{ id: 7 }],
    });
    const mock = makeMockFetch(() => ok(body));
    const service = new TMDBService("tmdb-key", mock.fetchImpl);

    expect(await service.findByImdbId("tt1", "series")).toBe(7);
  });

  it("returns null when there are no results of the requested type", async () => {
    const body = JSON.stringify({ movie_results: [], tv_results: [] });
    const mock = makeMockFetch(() => ok(body));
    const service = new TMDBService("tmdb-key", mock.fetchImpl);

    expect(await service.findByImdbId("tt1", "movie")).toBeNull();
  });
});

// MARK: - getSeasons / getEpisodes mapping

describe("TMDBService getSeasons", () => {
  it("maps raw seasons into Season objects and tolerates missing optionals", async () => {
    const body = JSON.stringify({
      id: 100,
      seasons: [
        {
          id: 1,
          season_number: 0,
          name: "Specials",
          overview: "Extras",
          poster_path: "/sp.jpg",
          episode_count: 3,
          air_date: "2019-12-01",
        },
        {
          id: 2,
          season_number: 1,
          name: "Season 1",
          episode_count: 10,
        },
      ],
    });
    const mock = makeMockFetch(() => ok(body));
    const service = new TMDBService("tmdb-key", mock.fetchImpl);

    const seasons = await service.getSeasons(100);
    expect(mock.lastURL()!.pathname).toBe("/3/tv/100");
    expect(seasons).toHaveLength(2);
    expect(seasons[0]).toEqual({
      id: 1,
      seasonNumber: 0,
      name: "Specials",
      overview: "Extras",
      posterPath: "/sp.jpg",
      episodeCount: 3,
      airDate: "2019-12-01",
    });
    expect(seasons[1].overview).toBeNull();
    expect(seasons[1].posterPath).toBeNull();
    expect(seasons[1].airDate).toBeNull();
  });

  it("returns an empty list when seasons is absent", async () => {
    const mock = makeMockFetch(() => ok(JSON.stringify({ id: 100 })));
    const service = new TMDBService("tmdb-key", mock.fetchImpl);

    expect(await service.getSeasons(100)).toEqual([]);
  });
});

describe("TMDBService getEpisodes", () => {
  it("maps episodes with synthesized ids and mediaId, tolerating missing optionals", async () => {
    const body = JSON.stringify({
      episodes: [
        {
          id: 11,
          episode_number: 1,
          name: "Pilot",
          overview: "It begins",
          air_date: "2020-01-01",
          still_path: "/still.jpg",
          runtime: 48,
        },
        { id: 12, episode_number: 2 },
      ],
    });
    const mock = makeMockFetch(() => ok(body));
    const service = new TMDBService("tmdb-key", mock.fetchImpl);

    const eps = await service.getEpisodes(555, 2);
    expect(mock.lastURL()!.pathname).toBe("/3/tv/555/season/2");
    expect(eps[0].id).toBe("555-s2e1");
    expect(eps[0].mediaId).toBe("tmdb-555");
    expect(eps[0].seasonNumber).toBe(2);
    expect(eps[0].episodeNumber).toBe(1);
    expect(eps[0].title).toBe("Pilot");
    expect(eps[0].stillPath).toBe("/still.jpg");
    expect(eps[0].runtime).toBe(48);

    expect(eps[1].id).toBe("555-s2e2");
    expect(eps[1].title).toBeNull();
    expect(eps[1].overview).toBeNull();
    expect(eps[1].airDate).toBeNull();
    expect(eps[1].stillPath).toBeNull();
    expect(eps[1].runtime).toBeNull();
  });
});

// MARK: - getExternalIds

describe("TMDBService getExternalIds", () => {
  it("maps imdb_id/tvdb_id and hits the external_ids path", async () => {
    const body = JSON.stringify({ imdb_id: "tt555", tvdb_id: 9000 });
    const mock = makeMockFetch(() => ok(body));
    const service = new TMDBService("tmdb-key", mock.fetchImpl);

    const ids = await service.getExternalIds(321, "series");
    expect(ids).toEqual({ imdbId: "tt555", tvdbId: 9000 });
    expect(mock.lastURL()!.pathname).toBe("/3/tv/321/external_ids");
  });

  it("maps missing ids to null and memoizes the result", async () => {
    const mock = makeMockFetch(() => ok(JSON.stringify({})));
    const service = new TMDBService("tmdb-key", mock.fetchImpl);

    const ids = await service.getExternalIds(321, "movie");
    expect(ids).toEqual({ imdbId: null, tvdbId: null });

    await service.getExternalIds(321, "movie");
    expect(mock.hits()).toBe(1);
  });

  it("deduplicates concurrent external-id reads before the cache is filled", async () => {
    let hits = 0;
    const fetchImpl: FetchImpl = async () => {
      hits += 1;
      return {
        status: 200,
        text: async () => JSON.stringify({ imdb_id: "tt321" }),
      };
    };
    const service = new TMDBService("tmdb-key", fetchImpl);

    const first = service.getExternalIds(321, "movie");
    const second = service.getExternalIds(321, "movie");
    await expect(Promise.all([first, second])).resolves.toEqual([
      { imdbId: "tt321", tvdbId: null },
      { imdbId: "tt321", tvdbId: null },
    ]);
    expect(hits).toBe(1);
  });
});

// MARK: - getCertification (movie release_dates / tv content_ratings)

describe("TMDBService getCertification movie", () => {
  it("returns the strictest US certification across release_dates", async () => {
    const body = JSON.stringify({
      results: [
        {
          iso_3166_1: "GB",
          release_dates: [{ certification: "15" }],
        },
        {
          iso_3166_1: "US",
          release_dates: [
            { certification: "PG-13" },
            { certification: "R" },
            { certification: "" }, // blank skipped
            { certification: null }, // null skipped
          ],
        },
      ],
    });
    const mock = makeMockFetch(() => ok(body));
    const service = new TMDBService("tmdb-key", mock.fetchImpl);

    const cert = await service.getCertification(123, "movie");
    expect(cert).toBe("R");
    expect(mock.lastURL()!.pathname).toBe("/3/movie/123/release_dates");
  });

  it("ranks an unrecognized certification highest (fail-closed)", async () => {
    const body = JSON.stringify({
      results: [
        {
          iso_3166_1: "US",
          release_dates: [{ certification: "R" }, { certification: "X-WEIRD" }],
        },
      ],
    });
    const mock = makeMockFetch(() => ok(body));
    const service = new TMDBService("tmdb-key", mock.fetchImpl);

    expect(await service.getCertification(123, "movie")).toBe("X-WEIRD");
  });

  it("trims whitespace from the chosen certification", async () => {
    const body = JSON.stringify({
      results: [
        { iso_3166_1: "US", release_dates: [{ certification: "  PG  " }] },
      ],
    });
    const mock = makeMockFetch(() => ok(body));
    const service = new TMDBService("tmdb-key", mock.fetchImpl);

    expect(await service.getCertification(123, "movie")).toBe("PG");
  });

  it("returns null when there is no US entry", async () => {
    const body = JSON.stringify({
      results: [{ iso_3166_1: "FR", release_dates: [{ certification: "12" }] }],
    });
    const mock = makeMockFetch(() => ok(body));
    const service = new TMDBService("tmdb-key", mock.fetchImpl);

    expect(await service.getCertification(123, "movie")).toBeNull();
  });

  it("returns null when the US entry has only blank certifications", async () => {
    const body = JSON.stringify({
      results: [
        {
          iso_3166_1: "US",
          release_dates: [{ certification: "   " }, { certification: "" }],
        },
      ],
    });
    const mock = makeMockFetch(() => ok(body));
    const service = new TMDBService("tmdb-key", mock.fetchImpl);

    expect(await service.getCertification(123, "movie")).toBeNull();
  });
});

describe("TMDBService getCertification tv", () => {
  it("returns the trimmed US content rating", async () => {
    const body = JSON.stringify({
      results: [
        { iso_3166_1: "GB", rating: "15" },
        { iso_3166_1: "US", rating: " TV-MA " },
      ],
    });
    const mock = makeMockFetch(() => ok(body));
    const service = new TMDBService("tmdb-key", mock.fetchImpl);

    const cert = await service.getCertification(456, "series");
    expect(cert).toBe("TV-MA");
    expect(mock.lastURL()!.pathname).toBe("/3/tv/456/content_ratings");
  });

  it("returns null when the US rating is blank or missing", async () => {
    const body = JSON.stringify({
      results: [{ iso_3166_1: "US", rating: "   " }],
    });
    const mock = makeMockFetch(() => ok(body));
    const service = new TMDBService("tmdb-key", mock.fetchImpl);

    expect(await service.getCertification(456, "series")).toBeNull();
  });

  it("memoizes certification with the long TTL (second read served from cache)", async () => {
    const body = JSON.stringify({
      results: [{ iso_3166_1: "US", rating: "TV-14" }],
    });
    const mock = makeMockFetch(() =>
      mock.hits() === 1 ? ok(body) : serverError("{}"),
    );
    const service = new TMDBService("tmdb-key", mock.fetchImpl);

    expect(await service.getCertification(456, "series")).toBe("TV-14");
    expect(await service.getCertification(456, "series")).toBe("TV-14");
    expect(mock.hits()).toBe(1);
  });
});

// MARK: - discover optional-filter branches

describe("TMDBService discover filter branches", () => {
  it("omits genre/year/rating params when they are null", async () => {
    const mock = makeMockFetch(() => ok(searchBody));
    const service = new TMDBService("tmdb-key", mock.fetchImpl);

    await service.discover("movie", {
      genreId: null,
      year: null,
      minRating: null,
      sortBy: "popularity.desc",
      page: 1,
    });

    const url = mock.lastURL()!;
    expect(url.searchParams.get("with_genres")).toBeNull();
    expect(url.searchParams.get("primary_release_year")).toBeNull();
    expect(url.searchParams.get("vote_average.gte")).toBeNull();
    expect(url.searchParams.get("vote_count.gte")).toBeNull();
    expect(url.searchParams.get("include_adult")).toBe("false");
  });

  it("uses first_air_date_year for series rather than primary_release_year", async () => {
    const mock = makeMockFetch(() => ok(searchBody));
    const service = new TMDBService("tmdb-key", mock.fetchImpl);

    await service.discover("series", {
      year: 2012,
      sortBy: "popularity.desc",
      page: 1,
    });

    const url = mock.lastURL()!;
    expect(url.pathname).toBe("/3/discover/tv");
    expect(url.searchParams.get("first_air_date_year")).toBe("2012");
    expect(url.searchParams.get("primary_release_year")).toBeNull();
  });
});

// MARK: - cache key independence + eviction

describe("TMDBService cache key behavior", () => {
  it("keys search results per query+page (different pages each hit the network)", async () => {
    const mock = makeMockFetch(() => ok(searchBody));
    const service = new TMDBService("tmdb-key", mock.fetchImpl);

    await service.search("q", "movie", 1);
    await service.search("q", "movie", 2);
    expect(mock.hits()).toBe(2);

    await service.search("q", "movie", 1); // repeat -> cached
    expect(mock.hits()).toBe(2);
  });

  it("does not cross-serve between movie and series for the same query", async () => {
    const mock = makeMockFetch(() => ok(searchBody));
    const service = new TMDBService("tmdb-key", mock.fetchImpl);

    await service.search("q", "movie", 1);
    await service.search("q", "series", 1);
    expect(mock.hits()).toBe(2);
  });
});

describe("TMDBService.getTrailer", () => {
  const trailerBody = (results: unknown[]) => JSON.stringify({ results });

  it("prefers the official YouTube trailer and hits the videos path", async () => {
    const mock = makeMockFetch(() =>
      ok(
        trailerBody([
          { key: "teaser1", site: "YouTube", type: "Teaser", official: true },
          { key: "unofficial", site: "YouTube", type: "Trailer", official: false },
          { key: "official1", site: "YouTube", type: "Trailer", official: true },
        ]),
      ),
    );
    const service = new TMDBService("tmdb-key", mock.fetchImpl);
    expect(await service.getTrailer(603, "movie")).toBe("official1");
    expect(mock.lastURL()?.pathname).toBe("/3/movie/603/videos");
  });

  it("falls back to any Trailer, then a Teaser", async () => {
    const t = makeMockFetch(() =>
      ok(trailerBody([{ key: "any", site: "YouTube", type: "Trailer", official: false }])),
    );
    expect(await new TMDBService("k", t.fetchImpl).getTrailer(1, "series")).toBe("any");

    const teaser = makeMockFetch(() =>
      ok(trailerBody([{ key: "te", site: "YouTube", type: "Teaser", official: false }])),
    );
    expect(await new TMDBService("k", teaser.fetchImpl).getTrailer(1, "movie")).toBe("te");
    // Series path resolves to /tv/.
    expect(t.lastURL()?.pathname).toBe("/3/tv/1/videos");
  });

  it("ignores non-YouTube videos and returns null when none qualify", async () => {
    const mock = makeMockFetch(() =>
      ok(trailerBody([{ key: "v", site: "Vimeo", type: "Trailer", official: true }])),
    );
    expect(await new TMDBService("k", mock.fetchImpl).getTrailer(1, "movie")).toBeNull();
  });

  it("returns null for an empty results list", async () => {
    const mock = makeMockFetch(() => ok(trailerBody([])));
    expect(await new TMDBService("k", mock.fetchImpl).getTrailer(1, "movie")).toBeNull();
  });
});

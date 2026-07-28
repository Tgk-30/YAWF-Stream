import Testing
import Foundation
@testable import DebridStreamer

@Suite("DiscoverAICurationService Tests")
struct DiscoverAICurationServiceTests {

    // MARK: - Helpers

    /// Builds a SettingsManager backed by a real temp database + in-memory secret store.
    private func makeSettings(_ db: DatabaseManager) -> SettingsManager {
        SettingsManager(database: db, secretStore: InMemorySecretStore())
    }

    /// Encodes recommendations and persists them as the discover-launch cache entry the
    /// service reads back via `cachedRecommendations()`.
    private func seedCache(
        _ db: DatabaseManager,
        recommendations: [AIMovieRecommendation],
        expiresAt: Date = Date().addingTimeInterval(60 * 60)
    ) async throws {
        let payload = try JSONEncoder().encode(recommendations)
        let entry = AICurationCacheEntry(
            cacheKey: "discover-launch-curated",
            payload: payload,
            model: "test-model",
            expiresAt: expiresAt
        )
        try await db.saveDiscoverAICacheEntry(entry)
    }

    private func makeService(
        database: DatabaseManager?,
        settings: SettingsManager?,
        metadataProvider: (any MetadataProvider)?
    ) -> DiscoverAICurationService {
        DiscoverAICurationService(
            assistantManager: nil,
            database: database,
            settings: settings,
            metadataProvider: metadataProvider
        )
    }

    private func makeManager(with recommendations: [AIMovieRecommendation]) -> (AIAssistantManager, MockRecommendationProvider) {
        let provider = MockRecommendationProvider(recommendations: recommendations)
        let manager = AIAssistantManager(
            providers: [.openAI: provider],
            database: nil,
            settings: nil,
            metadataProvider: nil
        )
        return (manager, provider)
    }

    private func makeManager(with recommendations: [AIMovieRecommendation], error: Error) -> (AIAssistantManager, MockRecommendationProvider) {
        let provider = MockRecommendationProvider(recommendations: recommendations, errorToThrow: error)
        let manager = AIAssistantManager(
            providers: [.openAI: provider],
            database: nil,
            settings: nil,
            metadataProvider: nil
        )
        return (manager, provider)
    }

    // MARK: - generateRecommendations

    @Test("generateRecommendations returns cached entries when available")
    func generateRecommendationsReturnsCachedEntries() async throws {
        let db = try makeTestDatabase()
        let cached = AIMovieRecommendation(
            title: "Cached One",
            year: 2020,
            reason: "cached",
            score: 0.9,
            mediaId: "cached-id",
            mediaType: .movie,
            posterPath: "/cache.jpg"
        )
        try await seedCache(db, recommendations: [cached])

        let fresh = AIMovieRecommendation(
            title: "Fresh One",
            year: 2021,
            reason: "fresh",
            score: 0.8,
            mediaId: "fresh-id",
            mediaType: .movie,
            posterPath: "/fresh.jpg"
        )
        let (manager, provider) = makeManager(with: [fresh])

        let service = DiscoverAICurationService(
            assistantManager: manager,
            database: db,
            settings: nil,
            metadataProvider: nil
        )

        let result = await service.generateRecommendations()

        #expect(result == [cached])
        #expect(await provider.callCount == 0)
    }

    @Test("generateRecommendations returns empty when no assistant manager is configured")
    func generateRecommendationsWithoutManagerReturnsEmpty() async throws {
        let db = try makeTestDatabase()
        let cached = AIMovieRecommendation(
            title: "Cached",
            year: 2020,
            reason: "cached",
            score: 0.9,
            mediaId: "cached-id",
            mediaType: .movie,
            posterPath: "/cache.jpg"
        )
        try await seedCache(db, recommendations: [cached])

        let service = makeService(database: db, settings: nil, metadataProvider: nil)
        let result = await service.generateRecommendations()

        #expect(result.isEmpty)
    }

    @Test("generateRecommendations bypasses cache when forced")
    func generateRecommendationsBypassCacheWhenForceRefresh() async throws {
        let db = try makeTestDatabase()
        let cached = AIMovieRecommendation(
            title: "Cached One",
            year: 2020,
            reason: "cached",
            score: 0.9,
            mediaId: "cached-id",
            mediaType: .movie,
            posterPath: "/cache.jpg"
        )
        try await seedCache(db, recommendations: [cached])

        let fresh = AIMovieRecommendation(
            title: "Fresh One",
            year: 2021,
            reason: "fresh",
            score: 0.8,
            mediaId: "fresh-id",
            mediaType: .movie,
            posterPath: "/fresh.jpg"
        )
        let (manager, provider) = makeManager(with: [fresh])
        let service = DiscoverAICurationService(
            assistantManager: manager,
            database: db,
            settings: nil,
            metadataProvider: nil
        )

        let result = await service.generateRecommendations(forceRefresh: true)

        #expect(result == [fresh])
        #expect(await provider.callCount == 1)
    }

    @Test("generateRecommendations caches fresh results")
    func generateRecommendationsCachesFreshResults() async throws {
        let db = try makeTestDatabase()
        let source = AIMovieRecommendation(
            title: "Generated",
            year: 2022,
            reason: "generated",
            score: 0.95,
            mediaId: "generated-id",
            mediaType: .movie,
            posterPath: "/generated.jpg"
        )
        let (manager, provider) = makeManager(with: [source])
        let service = DiscoverAICurationService(
            assistantManager: manager,
            database: db,
            settings: nil,
            metadataProvider: nil
        )

        let first = await service.generateRecommendations()
        let second = await service.generateRecommendations()

        #expect(first == [source])
        #expect(second == [source])
        #expect(await provider.callCount == 1)
    }

    @Test("generateRecommendations enriches with metadata search results")
    func generateRecommendationsEnrichesFromMetadata() async throws {
        let db = try makeTestDatabase()
        let recommendation = AIMovieRecommendation(
            title: "No Poster",
            year: nil,
            reason: "no poster yet",
            score: 0.8
        )

        let (manager, _) = makeManager(with: [recommendation])

        var metadataProvider = StubMetadataProvider()
        metadataProvider.searchResponse = MetadataSearchResult(
            items: [
                MediaPreview(
                    id: "tt-enriched",
                    type: .movie,
                    title: "No Poster",
                    year: 2023,
                    posterPath: "/enriched.jpg"
                )
            ],
            page: 1,
            totalPages: 1,
            totalResults: 1
        )

        let service = DiscoverAICurationService(
            assistantManager: manager,
            database: db,
            settings: nil,
            metadataProvider: metadataProvider
        )

        let result = await service.generateRecommendations()
        #expect(result.count == 1)
        let first = try #require(result.first)
        #expect(first.posterPath == "/enriched.jpg")
        #expect(first.mediaId == "tt-enriched")
        #expect(first.mediaType == .movie)
        #expect(first.year == 2023)
    }

    // MARK: - shouldGenerateOnLaunch

    @Test("shouldGenerateOnLaunch is false when both flags are unset")
    func shouldGenerateOnLaunchBothUnset() async throws {
        let db = try makeTestDatabase()
        let settings = makeSettings(db)
        let service = makeService(database: db, settings: settings, metadataProvider: nil)

        #expect(await service.shouldGenerateOnLaunch() == false)
    }

    @Test("shouldGenerateOnLaunch is false when only personalization is enabled")
    func shouldGenerateOnLaunchOnlyPersonalization() async throws {
        let db = try makeTestDatabase()
        let settings = makeSettings(db)
        try await settings.setPersonalizationEnabled(true)
        let service = makeService(database: db, settings: settings, metadataProvider: nil)

        #expect(await service.shouldGenerateOnLaunch() == false)
    }

    @Test("shouldGenerateOnLaunch is false when only discover-on-launch is enabled")
    func shouldGenerateOnLaunchOnlyDiscover() async throws {
        let db = try makeTestDatabase()
        let settings = makeSettings(db)
        try await settings.setDiscoverAICurationOnLaunchEnabled(true)
        let service = makeService(database: db, settings: settings, metadataProvider: nil)

        #expect(await service.shouldGenerateOnLaunch() == false)
    }

    @Test("shouldGenerateOnLaunch is true only when both flags are enabled")
    func shouldGenerateOnLaunchBothEnabled() async throws {
        let db = try makeTestDatabase()
        let settings = makeSettings(db)
        try await settings.setPersonalizationEnabled(true)
        try await settings.setDiscoverAICurationOnLaunchEnabled(true)
        let service = makeService(database: db, settings: settings, metadataProvider: nil)

        #expect(await service.shouldGenerateOnLaunch() == true)
    }

    @Test("shouldGenerateOnLaunch is false when settings dependency is nil")
    func shouldGenerateOnLaunchNilSettings() async throws {
        let db = try makeTestDatabase()
        let service = makeService(database: db, settings: nil, metadataProvider: nil)

        #expect(await service.shouldGenerateOnLaunch() == false)
    }

    // MARK: - cachedRecommendations

    @Test("cachedRecommendations returns empty when database is nil")
    func cachedRecommendationsNilDatabase() async throws {
        let service = makeService(database: nil, settings: nil, metadataProvider: nil)

        #expect(await service.cachedRecommendations().isEmpty)
    }

    @Test("cachedRecommendations returns empty when no cache entry exists")
    func cachedRecommendationsMissingCache() async throws {
        let db = try makeTestDatabase()
        let service = makeService(database: db, settings: nil, metadataProvider: nil)

        #expect(await service.cachedRecommendations().isEmpty)
    }

    @Test("cachedRecommendations returns empty when cached payload is undecodable")
    func cachedRecommendationsUndecodablePayload() async throws {
        let db = try makeTestDatabase()
        // Persist junk bytes under the service's cache key so decode fails.
        let entry = AICurationCacheEntry(
            cacheKey: "discover-launch-curated",
            payload: Data("not-json".utf8),
            model: nil,
            expiresAt: Date().addingTimeInterval(60 * 60)
        )
        try await db.saveDiscoverAICacheEntry(entry)
        let service = makeService(database: db, settings: nil, metadataProvider: nil)

        #expect(await service.cachedRecommendations().isEmpty)
    }

    @Test("cachedRecommendations round-trips a saved entry that already has a poster")
    func cachedRecommendationsRoundTrip() async throws {
        let db = try makeTestDatabase()
        let saved = AIMovieRecommendation(
            title: "Round Trip",
            year: 2021,
            reason: "saved",
            score: 0.8,
            mediaId: "tt-roundtrip",
            mediaType: .movie,
            posterPath: "/already.jpg"
        )
        try await seedCache(db, recommendations: [saved])
        // No metadata provider -> enrichMissingArtwork returns items unchanged.
        let service = makeService(database: db, settings: nil, metadataProvider: nil)

        let result = await service.cachedRecommendations()
        #expect(result.count == 1)
        let first = try #require(result.first)
        #expect(first.title == "Round Trip")
        #expect(first.year == 2021)
        #expect(first.posterPath == "/already.jpg")
        #expect(first.mediaId == "tt-roundtrip")
    }

    @Test("cachedRecommendations returns empty when the cache entry has expired")
    func cachedRecommendationsExpiredEntry() async throws {
        let db = try makeTestDatabase()
        let saved = AIMovieRecommendation(
            title: "Expired",
            year: 2000,
            reason: "old",
            score: 0.5,
            posterPath: "/exp.jpg"
        )
        // Expired in the past -> fetchDiscoverAICacheEntry filters it out.
        try await seedCache(db, recommendations: [saved], expiresAt: Date().addingTimeInterval(-60))
        let service = makeService(database: db, settings: nil, metadataProvider: nil)

        #expect(await service.cachedRecommendations().isEmpty)
    }

    // MARK: - enrichMissingArtwork (exercised through cachedRecommendations)

    @Test("enrichMissingArtwork leaves items that already have a posterPath untouched")
    func enrichLeavesPosteredItemsUntouched() async throws {
        let db = try makeTestDatabase()
        let postered = AIMovieRecommendation(
            title: "Has Poster",
            year: 2019,
            reason: "r",
            score: 0.9,
            mediaId: "orig-id",
            mediaType: .series,
            posterPath: "/keep.jpg"
        )
        try await seedCache(db, recommendations: [postered])

        // Provider would supply a different poster/id, but it must NOT be consulted
        // for items that already carry a posterPath.
        var provider = StubMetadataProvider()
        provider.searchResponse = MetadataSearchResult(
            items: [
                MediaPreview(
                    id: "should-not-be-used",
                    type: .movie,
                    title: "Has Poster",
                    year: 2019,
                    posterPath: "/different.jpg"
                )
            ],
            page: 1,
            totalPages: 1,
            totalResults: 1
        )
        let service = makeService(database: db, settings: nil, metadataProvider: provider)

        let result = await service.cachedRecommendations()
        let first = try #require(result.first)
        #expect(first.posterPath == "/keep.jpg")
        #expect(first.mediaId == "orig-id")
        #expect(first.mediaType == .series)
    }

    @Test("enrichMissingArtwork fills poster, mediaId, type and year from a search stub")
    func enrichFillsMissingArtworkFromSearch() async throws {
        let db = try makeTestDatabase()
        // Missing posterPath, missing mediaId, missing year -> all should be filled.
        let bare = AIMovieRecommendation(
            title: "Needs Artwork",
            year: nil,
            reason: "r",
            score: 0.7
        )
        try await seedCache(db, recommendations: [bare])

        var provider = StubMetadataProvider()
        provider.searchResponse = MetadataSearchResult(
            items: [
                MediaPreview(
                    id: "tmdb-555",
                    type: .movie,
                    title: "Needs Artwork",
                    year: 2022,
                    posterPath: "/filled.jpg"
                )
            ],
            page: 1,
            totalPages: 1,
            totalResults: 1
        )
        let service = makeService(database: db, settings: nil, metadataProvider: provider)

        let result = await service.cachedRecommendations()
        let first = try #require(result.first)
        #expect(first.posterPath == "/filled.jpg")
        #expect(first.mediaId == "tmdb-555")
        #expect(first.mediaType == .movie)
        #expect(first.year == 2022)
    }

    @Test("enrichMissingArtwork keeps an existing year when the preview supplies a different one")
    func enrichPreservesExistingYear() async throws {
        let db = try makeTestDatabase()
        // Has a year already (1999) but no poster; search preview reports a different year.
        let bare = AIMovieRecommendation(
            title: "Year Keeper",
            year: 1999,
            reason: "r",
            score: 0.6
        )
        try await seedCache(db, recommendations: [bare])

        var provider = StubMetadataProvider()
        provider.searchResponse = MetadataSearchResult(
            items: [
                MediaPreview(
                    id: "tmdb-99",
                    type: .movie,
                    title: "Year Keeper",
                    year: 1999,
                    posterPath: "/yk.jpg"
                )
            ],
            page: 1,
            totalPages: 1,
            totalResults: 1
        )
        let service = makeService(database: db, settings: nil, metadataProvider: provider)

        let result = await service.cachedRecommendations()
        let first = try #require(result.first)
        #expect(first.year == 1999)
        #expect(first.posterPath == "/yk.jpg")
        #expect(first.mediaId == "tmdb-99")
    }

    @Test("enrichMissingArtwork leaves item unchanged when search throws")
    func enrichUnchangedWhenSearchThrows() async throws {
        let db = try makeTestDatabase()
        let bare = AIMovieRecommendation(
            title: "Search Fails",
            year: 2020,
            reason: "r",
            score: 0.4
        )
        try await seedCache(db, recommendations: [bare])

        var provider = StubMetadataProvider()
        provider.searchError = URLError(.notConnectedToInternet)
        let service = makeService(database: db, settings: nil, metadataProvider: provider)

        let result = await service.cachedRecommendations()
        let first = try #require(result.first)
        #expect(first.posterPath == nil)
        #expect(first.mediaId == nil)
        #expect(first.title == "Search Fails")
    }

    @Test("enrichMissingArtwork leaves item unchanged when no preview has a poster")
    func enrichUnchangedWhenNoPosteredPreview() async throws {
        let db = try makeTestDatabase()
        let bare = AIMovieRecommendation(
            title: "No Poster Anywhere",
            year: 2018,
            reason: "r",
            score: 0.3
        )
        try await seedCache(db, recommendations: [bare])

        var provider = StubMetadataProvider()
        // Single preview with NO posterPath -> bestPreview falls through to previews.first,
        // whose posterPath is nil, so enriched.posterPath stays nil but id/type are still set.
        provider.searchResponse = MetadataSearchResult(
            items: [
                MediaPreview(
                    id: "no-art",
                    type: .movie,
                    title: "No Poster Anywhere",
                    year: 2018,
                    posterPath: nil
                )
            ],
            page: 1,
            totalPages: 1,
            totalResults: 1
        )
        let service = makeService(database: db, settings: nil, metadataProvider: provider)

        let result = await service.cachedRecommendations()
        let first = try #require(result.first)
        // posterPath comes straight from the preview (nil here).
        #expect(first.posterPath == nil)
        // bestPreview still returned a preview, so id/type were copied across.
        #expect(first.mediaId == "no-art")
        #expect(first.mediaType == .movie)
    }

    // MARK: - bestPreview ranking (exercised through enrichMissingArtwork)

    @Test("bestPreview prefers an exact-year postered match over other candidates")
    func bestPreviewPrefersExactYear() async throws {
        let db = try makeTestDatabase()
        let bare = AIMovieRecommendation(
            title: "Ambiguous Title",
            year: 2010,
            reason: "r",
            score: 0.8
        )
        try await seedCache(db, recommendations: [bare])

        var provider = StubMetadataProvider()
        provider.searchResponse = MetadataSearchResult(
            items: [
                // Exact title match but wrong year -> should lose to the exact-year entry.
                MediaPreview(id: "title-match", type: .movie, title: "Ambiguous Title", year: 1995, posterPath: "/title.jpg"),
                // Exact-year postered match -> should win.
                MediaPreview(id: "year-match", type: .movie, title: "Different Name", year: 2010, posterPath: "/year.jpg")
            ],
            page: 1,
            totalPages: 1,
            totalResults: 2
        )
        let service = makeService(database: db, settings: nil, metadataProvider: provider)

        let result = await service.cachedRecommendations()
        let first = try #require(result.first)
        #expect(first.mediaId == "year-match")
        #expect(first.posterPath == "/year.jpg")
    }

    @Test("bestPreview falls back to an exact-title postered match when no year matches")
    func bestPreviewPrefersExactTitle() async throws {
        let db = try makeTestDatabase()
        let bare = AIMovieRecommendation(
            title: "Specific Title",
            year: 2030,
            reason: "r",
            score: 0.8
        )
        try await seedCache(db, recommendations: [bare])

        var provider = StubMetadataProvider()
        provider.searchResponse = MetadataSearchResult(
            items: [
                // First overall, postered, but title differs and year doesn't match -> third choice.
                MediaPreview(id: "first-postered", type: .movie, title: "Unrelated", year: 1980, posterPath: "/first.jpg"),
                // Exact title (case-insensitive) match with a poster -> should win since no year matches.
                MediaPreview(id: "title-match", type: .movie, title: "specific title", year: 1981, posterPath: "/title.jpg")
            ],
            page: 1,
            totalPages: 1,
            totalResults: 2
        )
        let service = makeService(database: db, settings: nil, metadataProvider: provider)

        let result = await service.cachedRecommendations()
        let first = try #require(result.first)
        #expect(first.mediaId == "title-match")
        #expect(first.posterPath == "/title.jpg")
    }

    @Test("bestPreview falls back to the first postered preview when neither year nor title match")
    func bestPreviewFallsBackToFirstPostered() async throws {
        let db = try makeTestDatabase()
        let bare = AIMovieRecommendation(
            title: "Unmatchable",
            year: 2040,
            reason: "r",
            score: 0.8
        )
        try await seedCache(db, recommendations: [bare])

        var provider = StubMetadataProvider()
        provider.searchResponse = MetadataSearchResult(
            items: [
                // No poster -> skipped by the postered fallback.
                MediaPreview(id: "no-poster", type: .movie, title: "Other A", year: 1, posterPath: nil),
                // First WITH a poster (wrong year, wrong title) -> should win as the final fallback.
                MediaPreview(id: "first-postered", type: .movie, title: "Other B", year: 2, posterPath: "/fp.jpg"),
                MediaPreview(id: "second-postered", type: .movie, title: "Other C", year: 3, posterPath: "/sp.jpg")
            ],
            page: 1,
            totalPages: 1,
            totalResults: 3
        )
        let service = makeService(database: db, settings: nil, metadataProvider: provider)

        let result = await service.cachedRecommendations()
        let first = try #require(result.first)
        #expect(first.mediaId == "first-postered")
        #expect(first.posterPath == "/fp.jpg")
    }
}

private actor MockRecommendationProvider: AIAssistantProvider {
    nonisolated let kind: AIProviderKind = .openAI
    private var recommendationCalls = 0
    private let recommendations: [AIMovieRecommendation]
    private let errorToThrow: Error?

    init(recommendations: [AIMovieRecommendation], errorToThrow: Error? = nil) {
        self.recommendations = recommendations
        self.errorToThrow = errorToThrow
    }

    var callCount: Int {
        recommendationCalls
    }

    func recommend(prompt: String, candidateTitles: [String], maxResults: Int) async throws -> AIProviderRecommendationResult {
        recommendationCalls += 1
        if let errorToThrow {
            throw errorToThrow
        }

        return AIProviderRecommendationResult(
            model: "test",
            recommendations: Array(recommendations.prefix(maxResults)),
            rawText: nil,
            usage: nil
        )
    }
}

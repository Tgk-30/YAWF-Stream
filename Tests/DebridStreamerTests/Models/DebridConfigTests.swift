import Testing
import Foundation
import GRDB
@testable import DebridStreamer

@Suite("DebridServiceType Tests")
struct DebridServiceTypeTests {
    @Test("Short codes")
    func shortCodes() {
        #expect(DebridServiceType.realDebrid.shortCode == "RD")
        #expect(DebridServiceType.allDebrid.shortCode == "AD")
        #expect(DebridServiceType.premiumize.shortCode == "PM")
        #expect(DebridServiceType.torBox.shortCode == "TB")
    }

    @Test("Display names")
    func displayNames() {
        #expect(DebridServiceType.realDebrid.displayName == "Real-Debrid")
        #expect(DebridServiceType.allDebrid.displayName == "AllDebrid")
        #expect(DebridServiceType.premiumize.displayName == "Premiumize")
        #expect(DebridServiceType.torBox.displayName == "TorBox")
    }

    @Test("Base URLs")
    func baseURLs() {
        #expect(DebridServiceType.realDebrid.baseURL.contains("real-debrid.com"))
        #expect(DebridServiceType.allDebrid.baseURL.contains("alldebrid.com"))
        #expect(DebridServiceType.premiumize.baseURL.contains("premiumize.me"))
        #expect(DebridServiceType.torBox.baseURL.contains("torbox.app"))
    }

    @Test("All cases")
    func allCases() {
        #expect(DebridServiceType.allCases.count == 4)
    }

    @Test("Raw values")
    func rawValues() {
        #expect(DebridServiceType.realDebrid.rawValue == "real_debrid")
        #expect(DebridServiceType.allDebrid.rawValue == "all_debrid")
        #expect(DebridServiceType.premiumize.rawValue == "premiumize")
        #expect(DebridServiceType.torBox.rawValue == "torbox")
    }
}

@Suite("DebridConfig Tests")
struct DebridConfigTests {
    @Test("DebridConfig creation")
    func creation() {
        let config = DebridConfig(
            id: "rd-1",
            service: .realDebrid,
            apiToken: "test-token",
            isActive: true,
            priority: 0
        )
        #expect(config.id == "rd-1")
        #expect(config.service == .realDebrid)
        #expect(config.apiToken == "test-token")
        #expect(config.isActive == true)
        #expect(config.priority == 0)
    }

    @Test("DebridConfig row init falls back when service is unknown")
    func rowInitFallsBackForUnknownService() throws {
        let row = Row([
            DebridConfig.Columns.id.rawValue: "rd-legacy",
            DebridConfig.Columns.service.rawValue: "unknown-service",
            DebridConfig.Columns.apiToken.rawValue: "legacy-token",
            DebridConfig.Columns.isActive.rawValue: false,
            DebridConfig.Columns.priority.rawValue: 7
        ])
        let config = try DebridConfig(row: row)

        #expect(config.id == "rd-legacy")
        #expect(config.service == .realDebrid)
        #expect(config.apiToken == "legacy-token")
        #expect(config.isActive == false)
        #expect(config.priority == 7)
    }

    @Test("DebridConfig can round-trip through the persistence layer")
    func debirdConfigPersistenceRoundTrip() throws {
        let original = DebridConfig(
            id: "rd-persist",
            service: .torBox,
            apiToken: "persist-token",
            isActive: false,
            priority: 4
        )

        let database = try DatabaseQueue(named: "debrid-config")
        try database.write { db in
            try db.create(table: DebridConfig.databaseTableName) { table in
                table.primaryKey("id", .text)
                table.column("service", .text).notNull()
                table.column("apiToken", .text).notNull()
                table.column("isActive", .boolean).notNull()
                table.column("priority", .integer).notNull()
            }
            try original.insert(db)

            let row = try #require(try Row.fetchOne(db, sql: "SELECT * FROM \(DebridConfig.databaseTableName) WHERE id = ?", arguments: [original.id]))
            let decoded = try DebridConfig(row: row)

            #expect(decoded == original)
            #expect(row[DebridConfig.Columns.service] as String == DebridServiceType.torBox.rawValue)
        }
    }

    @Test("DebridConfig defaults")
    func defaults() {
        let config = DebridConfig(
            id: "ad-1",
            service: .allDebrid,
            apiToken: "token"
        )
        #expect(config.isActive == true)
        #expect(config.priority == 0)
    }
}

@Suite("IndexerConfig Tests")
struct IndexerConfigTests {
    @Test("Provider subtype display names")
    func providerSubtypeDisplayNames() {
        #expect(IndexerConfig.ProviderSubtype.jackett.displayName == "Jackett")
        #expect(IndexerConfig.ProviderSubtype.prowlarr.displayName == "Prowlarr")
        #expect(IndexerConfig.ProviderSubtype.customTorznab.displayName == "Custom Torznab")
        #expect(IndexerConfig.ProviderSubtype.stremioAddon.displayName == "Stremio Addon")
        #expect(IndexerConfig.ProviderSubtype.builtIn.displayName == "Built-in")
    }

    @Test("IndexerType display names")
    func indexerTypeDisplayNames() {
        #expect(IndexerConfig.IndexerType.jackett.displayName == "Jackett")
        #expect(IndexerConfig.IndexerType.prowlarr.displayName == "Prowlarr")
        #expect(IndexerConfig.IndexerType.torznab.displayName == "Torznab")
        #expect(IndexerConfig.IndexerType.zilean.displayName == "Zilean")
        #expect(IndexerConfig.IndexerType.builtIn.displayName == "Built-in Scrapers")
    }

    @Test("IndexerConfig creation")
    func creation() {
        let config = IndexerConfig(
            id: "jackett-1",
            type: .jackett,
            baseURL: "http://localhost:9117",
            apiKey: "abc123"
        )
        #expect(config.id == "jackett-1")
        #expect(config.type == .jackett)
        #expect(config.baseURL == "http://localhost:9117")
        #expect(config.apiKey == "abc123")
        #expect(config.isActive == true)
        #expect(config.priority == 0)
        #expect(config.endpointPath.contains("torznab"))
    }

    @Test("IndexerConfig row init falls back to defaults for malformed rows")
    func rowInitFallsBackToDefaults() throws {
        let row = Row([
            IndexerConfig.Columns.id.rawValue: "prowlarr-legacy",
            IndexerConfig.Columns.type.rawValue: IndexerConfig.IndexerType.prowlarr.rawValue,
            IndexerConfig.Columns.baseURL.rawValue: "https://legacy.example",
            IndexerConfig.Columns.isActive.rawValue: true,
            IndexerConfig.Columns.providerSubtype.rawValue: "not-real",
            IndexerConfig.Columns.endpointPath.rawValue: NSNull()
        ])

        let config = try IndexerConfig(row: row)
        #expect(config.id == "prowlarr-legacy")
        #expect(config.type == .prowlarr)
        #expect(config.providerSubtype == .prowlarr)
        #expect(config.endpointPath == "/api/v1/search")
        #expect(config.categoryFilter == nil)
    }

    @Test("IndexerConfig row init defaults per type and returns fallback values")
    func rowInitAppliesDefaultProviderSubtypeForEachType() throws {
        let rows: [(type: IndexerConfig.IndexerType, expectedSubtype: IndexerConfig.ProviderSubtype, expectedEndpoint: String)] = [
            (.jackett, .jackett, "/api/v2.0/indexers/all/results/torznab/api"),
            (.prowlarr, .prowlarr, "/api/v1/search"),
            (.torznab, .customTorznab, "/api"),
            (.zilean, .customTorznab, "/api"),
            (.stremioAddon, .stremioAddon, ""),
            (.builtIn, .builtIn, "")
        ]

        for item in rows {
            let row = Row([
                IndexerConfig.Columns.id.rawValue: "test-\(item.type.rawValue)",
                IndexerConfig.Columns.type.rawValue: item.type.rawValue,
                IndexerConfig.Columns.baseURL.rawValue: "https://example.com",
                IndexerConfig.Columns.isActive.rawValue: true,
                IndexerConfig.Columns.providerSubtype.rawValue: "",
                IndexerConfig.Columns.endpointPath.rawValue: NSNull()
            ])
            let config = try IndexerConfig(row: row)
            #expect(config.type == item.type)
            #expect(config.providerSubtype == item.expectedSubtype)
            #expect(config.endpointPath == item.expectedEndpoint)
        }
    }
}

@Suite("DebridError Tests")
struct DebridErrorTests {
    @Test("Error descriptions")
    func errorDescriptions() {
        #expect(DebridError.invalidToken.errorDescription?.contains("Invalid") == true)
        #expect(DebridError.expired.errorDescription?.contains("expired") == true)
        #expect(DebridError.rateLimited.errorDescription?.contains("Rate limit") == true)
        #expect(DebridError.torrentNotFound("abc").errorDescription?.contains("abc") == true)
        #expect(DebridError.noFilesAvailable.errorDescription?.contains("No downloadable") == true)
        #expect(DebridError.downloadFailed("reason").errorDescription?.contains("reason") == true)
        #expect(DebridError.httpError(500, "server error").errorDescription?.contains("500") == true)
        #expect(DebridError.networkError("timeout").errorDescription?.contains("timeout") == true)
    }

    @Test("Error equality")
    func errorEquality() {
        #expect(DebridError.invalidToken == DebridError.invalidToken)
        #expect(DebridError.httpError(404, "not found") == DebridError.httpError(404, "not found"))
        #expect(DebridError.httpError(404, "not found") != DebridError.httpError(500, "server error"))
    }
}

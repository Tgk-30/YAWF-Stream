import Testing
import Foundation
@testable import DebridStreamer

@Suite("OMDBService Tests")
struct OMDBServiceTests {
    @Test("Parses a full OMDB body into imdbRating, RT percent and metascore")
    func parsesFullBody() async throws {
        let sessionID = UUID().uuidString
        let session = makeMockSession(sessionID: sessionID)
        var capturedRequest: URLRequest?

        MockURLProtocol.setHandler({ request in
            capturedRequest = request
            return try omdbResponse(for: request, statusCode: 200, body: omdbFullBody)
        }, for: sessionID)
        defer { MockURLProtocol.removeHandler(for: sessionID) }

        let service = OMDBService(apiKey: "test-key", session: session)
        let ratings = try await service.fetchRatings(imdbId: "tt0111161")

        #expect(ratings.imdbRating == 9.3)
        #expect(ratings.rtPercent == 74)
        #expect(ratings.metascore == 82)

        // The request carries the imdb id and api key as query params.
        let query = try #require(capturedRequest?.url?.query)
        #expect(query.contains("i=tt0111161"))
        #expect(query.contains("apikey=test-key"))
    }

    @Test("Missing / N/A / garbage values defensively decode to nil without crashing")
    func defensiveParsingYieldsNil() async throws {
        let sessionID = UUID().uuidString
        let session = makeMockSession(sessionID: sessionID)

        MockURLProtocol.setHandler({ request in
            return try omdbResponse(for: request, statusCode: 200, body: omdbNAValuesBody)
        }, for: sessionID)
        defer { MockURLProtocol.removeHandler(for: sessionID) }

        let service = OMDBService(apiKey: "test-key", session: session)
        let ratings = try await service.fetchRatings(imdbId: "tt0000000")

        #expect(ratings.imdbRating == nil)
        #expect(ratings.rtPercent == nil)
        #expect(ratings.metascore == nil)
    }

    @Test("Body with no Ratings array and absent fields decodes to all-nil ratings")
    func emptyBodyYieldsAllNil() async throws {
        let sessionID = UUID().uuidString
        let session = makeMockSession(sessionID: sessionID)

        MockURLProtocol.setHandler({ request in
            return try omdbResponse(for: request, statusCode: 200, body: #"{"Response":"True"}"#)
        }, for: sessionID)
        defer { MockURLProtocol.removeHandler(for: sessionID) }

        let service = OMDBService(apiKey: "test-key", session: session)
        let ratings = try await service.fetchRatings(imdbId: "tt1234567")

        #expect(ratings == OMDBRatings(imdbRating: nil, rtPercent: nil, metascore: nil))
    }

    @Test("Rotten Tomatoes percent is pulled from the Ratings array even with other sources present")
    func rottenTomatoesParsedFromRatingsArray() async throws {
        let sessionID = UUID().uuidString
        let session = makeMockSession(sessionID: sessionID)

        MockURLProtocol.setHandler({ request in
            let body = """
            {
              "imdbRating": "7.6",
              "Metascore": "N/A",
              "Ratings": [
                { "Source": "Internet Movie Database", "Value": "7.6/10" },
                { "Source": "Rotten Tomatoes", "Value": "91%" },
                { "Source": "Metacritic", "Value": "65/100" }
              ],
              "Response": "True"
            }
            """
            return try omdbResponse(for: request, statusCode: 200, body: body)
        }, for: sessionID)
        defer { MockURLProtocol.removeHandler(for: sessionID) }

        let service = OMDBService(apiKey: "test-key", session: session)
        let ratings = try await service.fetchRatings(imdbId: "tt7654321")

        #expect(ratings.imdbRating == 7.6)
        #expect(ratings.rtPercent == 91)
        #expect(ratings.metascore == nil)
    }

    @Test("Rotten Tomatoes percent is clamped to a maximum of 100")
    func rottenTomatoesPercentClamped() async throws {
        let sessionID = UUID().uuidString
        let session = makeMockSession(sessionID: sessionID)

        MockURLProtocol.setHandler({ request in
            let body = """
            {
              "imdbRating": "8.1",
              "Metascore": "88",
              "Ratings": [
                { "Source": "Rotten Tomatoes", "Value": "140%" }
              ],
              "Response": "True"
            }
            """
            return try omdbResponse(for: request, statusCode: 200, body: body)
        }, for: sessionID)
        defer { MockURLProtocol.removeHandler(for: sessionID) }

        let service = OMDBService(apiKey: "test-key", session: session)
        let ratings = try await service.fetchRatings(imdbId: "tt1231231")

        #expect(ratings.rtPercent == 100)
    }

    @Test("A Response:False body throws OMDBError.notFound")
    func responseFalseThrowsNotFound() async throws {
        let sessionID = UUID().uuidString
        let session = makeMockSession(sessionID: sessionID)

        MockURLProtocol.setHandler({ request in
            let body = #"{"Response":"False","Error":"Incorrect IMDb ID."}"#
            return try omdbResponse(for: request, statusCode: 200, body: body)
        }, for: sessionID)
        defer { MockURLProtocol.removeHandler(for: sessionID) }

        let service = OMDBService(apiKey: "test-key", session: session)

        await #expect(throws: OMDBError.notFound("Incorrect IMDb ID.")) {
            _ = try await service.fetchRatings(imdbId: "ttbogus")
        }
    }

    @Test("A non-2xx HTTP status throws OMDBError.httpError")
    func httpErrorStatusThrows() async throws {
        let sessionID = UUID().uuidString
        let session = makeMockSession(sessionID: sessionID)

        MockURLProtocol.setHandler({ request in
            return try omdbResponse(for: request, statusCode: 503, body: "{}")
        }, for: sessionID)
        defer { MockURLProtocol.removeHandler(for: sessionID) }

        let service = OMDBService(apiKey: "test-key", session: session)

        await #expect(throws: OMDBError.httpError(503)) {
            _ = try await service.fetchRatings(imdbId: "tt0111161")
        }
    }

    @Test("Invalid JSON payload throws decoding error")
    func invalidPayloadThrowsDecodingError() async throws {
        let sessionID = UUID().uuidString
        let session = makeMockSession(sessionID: sessionID)

        MockURLProtocol.setHandler({ request in
            return try omdbResponse(for: request, statusCode: 200, body: #"not-json-payload"#)
        }, for: sessionID)
        defer { MockURLProtocol.removeHandler(for: sessionID) }

        let service = OMDBService(apiKey: "test-key", session: session)

        await #expect(throws: Error.self) {
            _ = try await service.fetchRatings(imdbId: "tt0111161")
        }
    }

    @Test("Rotten Tomatoes percent ignores nonnumeric values")
    func rottenTomatoesNonNumericIgnored() async throws {
        let sessionID = UUID().uuidString
        let session = makeMockSession(sessionID: sessionID)

        MockURLProtocol.setHandler({ request in
            let body = """
            {
              "Ratings": [
                { "Source": "Rotten Tomatoes", "Value": "N/A-ish" }
              ],
              "Response": "True"
            }
            """
            return try omdbResponse(for: request, statusCode: 200, body: body)
        }, for: sessionID)
        defer { MockURLProtocol.removeHandler(for: sessionID) }

        let service = OMDBService(apiKey: "test-key", session: session)
        let ratings = try await service.fetchRatings(imdbId: "tt9999999")

        #expect(ratings.rtPercent == nil)
        #expect(ratings.imdbRating == nil)
        #expect(ratings.metascore == nil)
    }

    @Test("A non-http response throws OMDBError.invalidResponse")
    func nonHTTPResponseThrows() async throws {
        let sessionID = UUID().uuidString
        let session = makeMockSessionWithProtocol(sessionID: sessionID, protocolClass: NonHTTPURLResponseProtocol.self)

        NonHTTPURLResponseProtocol.setHandler(for: sessionID, handler: { request in
            guard let url = request.url else {
                throw NSError(domain: "OMDBServiceTests", code: 1)
            }
            let response = URLResponse(url: url, mimeType: nil, expectedContentLength: 0, textEncodingName: nil)
            return (response, Data("{}".utf8))
        })
        defer { NonHTTPURLResponseProtocol.removeHandler(for: sessionID) }

        let service = OMDBService(apiKey: "test-key", session: session)

        await #expect(throws: OMDBError.invalidResponse) {
            _ = try await service.fetchRatings(imdbId: "tt0111161")
        }
    }
}

// MARK: - Fixtures & helpers (fileprivate to avoid cross-file symbol collisions)

/// A representative full OMDB lookup body with every parseable field populated.
private let omdbFullBody = """
{
  "Title": "The Shawshank Redemption",
  "Year": "1994",
  "imdbRating": "9.3",
  "imdbVotes": "2,800,000",
  "Metascore": "82",
  "Ratings": [
    { "Source": "Internet Movie Database", "Value": "9.3/10" },
    { "Source": "Rotten Tomatoes", "Value": "74%" },
    { "Source": "Metacritic", "Value": "82/100" }
  ],
  "Response": "True"
}
"""

/// Same shape, but every value OMDB can return as missing is "N/A", empty, or
/// non-numeric garbage - all must defensively decode to nil.
private let omdbNAValuesBody = """
{
  "Title": "Some Obscure Short",
  "imdbRating": "N/A",
  "Metascore": "",
  "Ratings": [
    { "Source": "Rotten Tomatoes", "Value": "N/A" }
  ],
  "Response": "True"
}
"""

private final class NonHTTPURLResponseProtocol: URLProtocol {
    typealias Handler = (URLRequest) throws -> (URLResponse, Data)

    nonisolated(unsafe) static var requestHandler: Handler?

    static func setHandler(for sessionID: String, handler: @escaping Handler) {
        requestHandler = handler
    }

    static func removeHandler(for sessionID: String) {
        requestHandler = nil
    }

    override class func canInit(with request: URLRequest) -> Bool {
        true
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest {
        request
    }

    override func startLoading() {
        guard let handler = Self.requestHandler else {
            client?.urlProtocol(self, didFailWithError: NSError(domain: "NonHTTPURLResponseProtocol", code: 0))
            return
        }

        do {
            let (response, data) = try handler(request)
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}
}

private func makeMockSessionWithProtocol(sessionID: String, protocolClass: URLProtocol.Type) -> URLSession {
    let config = URLSessionConfiguration.ephemeral
    config.protocolClasses = [protocolClass]
    config.httpAdditionalHeaders = [MockURLProtocol.sessionHeader: sessionID]
    return URLSession(configuration: config)
}

private func omdbResponse(
    for request: URLRequest,
    statusCode: Int,
    body: String
) throws -> (HTTPURLResponse, Data) {
    guard let url = request.url else {
        throw NSError(domain: "OMDBServiceTests", code: 1)
    }
    guard let response = HTTPURLResponse(
        url: url,
        statusCode: statusCode,
        httpVersion: nil,
        headerFields: nil
    ) else {
        throw NSError(domain: "OMDBServiceTests", code: 2)
    }
    return (response, Data(body.utf8))
}

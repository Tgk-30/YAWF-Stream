import XCTest
import UIKit

private enum QAError: Error { case guardFailed(String) }
private struct Arrival: Decodable {
    let schemaVersion: Int
    let fixtureInstanceId: UUID
    let sourceRevision: String
    let loginSuccessCount: Int
}
private enum ArrivalReadPolicy {
    static func requireStable(_ first: Arrival, _ second: Arrival, expectedCount: Int) throws {
        guard first.schemaVersion == 1, second.schemaVersion == 1,
              first.fixtureInstanceId == second.fixtureInstanceId,
              first.sourceRevision == second.sourceRevision,
              expectedCount >= 0, first.loginSuccessCount == expectedCount,
              second.loginSuccessCount == expectedCount else {
            throw QAError.guardFailed("Read-only arrival observations must retain identical fixture identity, source and count.")
        }
    }
}
private struct WatchlistPageObservation {
    let welcomeTourPresent: Bool
    let headingCount: Int
    let headingVisible: Bool
    let descriptionCount: Int
    let descriptionVisible: Bool
    let movieCount: Int
    let movieVisible: Bool
}
private enum WatchlistPagePolicy {
    static func isReady(_ value: WatchlistPageObservation) -> Bool {
        !value.welcomeTourPresent && value.headingCount == 1 && value.headingVisible &&
            value.descriptionCount == 1 && value.descriptionVisible && value.movieCount == 1 && value.movieVisible
    }
    static func requireSettled(_ first: WatchlistPageObservation, _ second: WatchlistPageObservation) throws {
        guard isReady(first), isReady(second) else {
            throw QAError.guardFailed("A settled unique Watchlist page and synthetic movie, without the Welcome tour, are required.")
        }
    }
}
private struct Health: Decodable {
    let ok: Bool
    let ready: Bool
    let version: String
    let setupRequired: Bool
    let setupTokenRequired: Bool
}
private final class NoRedirect: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

@MainActor
final class SafariNativeInputTests: XCTestCase {
    private let anchor = XCUIApplication(bundleIdentifier: "com.yawf.tests.ipadnativeqa.anchor")
    private let safari = XCUIApplication(bundleIdentifier: "com.apple.mobilesafari")
    private let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
    private var anchorStarted = false
    private var safariStarted = false
    private let origin = URL(string: "http://127.0.0.1:43178/")!

    override func setUpWithError() throws {
        continueAfterFailure = false
        executionTimeAllowance = 120
        let environment = ProcessInfo.processInfo.environment
        guard let expected = environment["QA_EXPECTED_UDID"], let expectedID = UUID(uuidString: expected),
              let actual = environment["SIMULATOR_UDID"], UUID(uuidString: actual) == expectedID,
              let name = environment["QA_OWNED_DEVICE_NAME"], name.hasPrefix("YAWF-iPad-NativeQA-"),
              environment["SIMULATOR_DEVICE_NAME"] == name, UIDevice.current.userInterfaceIdiom == .pad else {
            throw QAError.guardFailed("Exact root-owned new iPad destination is required; no fallback is permitted.")
        }
    }

    override func record(_ issue: XCTIssue) {
        // Retain the actual owned screen before teardown terminates the anchor.
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = "native-input-failure-before-teardown"
        attachment.lifetime = .keepAlways
        add(attachment)
        super.record(issue)
    }

    override func tearDown() {
        if safariStarted { safari.terminate() }
        if anchorStarted { anchor.terminate() }
        super.tearDown()
    }

    func testNativeCounterInput() throws { try proveNativeCounterInput() }

    private func proveNativeCounterInput() throws {
        anchorStarted = true
        anchor.launch()
        try rejectUnexpectedPrompts(in: anchor)
        let button = anchor.buttons["qa.counter.increment"]
        let value = anchor.staticTexts["qa.counter.value"]
        XCTAssertTrue(button.waitForExistence(timeout: 15))
        XCTAssertTrue(button.isHittable)
        XCTAssertEqual(value.value as? String, "0")
        for expected in 1...3 {
            button.tap()
            let changed = NSPredicate(format: "value == %@", String(expected))
            expectation(for: changed, evaluatedWith: value)
            waitForExpectations(timeout: 5)
            XCTAssertEqual(value.label, "Counter: \(expected)")
        }
        XCTAssertEqual(value.value as? String, "3")
        keepScreenshot(anchor, name: "native-counter-three-real-taps")
    }

    func testSafariPublicFixtureLogin() async throws {
        let environment = ProcessInfo.processInfo.environment
        guard let probeText = environment["QA_HTTP_PROBE_URL"], let probe = URLComponents(string: probeText),
              probe.scheme == "http", probe.host == "127.0.0.1", probe.port == 43178,
              probe.path == "/__qa/arrival", probe.user == nil, probe.password == nil, probe.query == nil, probe.fragment == nil,
              let probeURL = probe.url,
              let instanceText = environment["QA_EXPECTED_FIXTURE_ID"], let instance = UUID(uuidString: instanceText),
              let revision = environment["QA_EXPECTED_SOURCE_REVISION"], revision.range(of: "^[a-f0-9]{40}$", options: .regularExpression) != nil else {
            throw QAError.guardFailed("Root-provided loopback arrival probe, public instance UUID and source revision are mandatory.")
        }
        try proveNativeCounterInput()
        let health: Health = try await readJSON(origin.appendingPathComponent("api/health"))
        guard health.ok, health.ready, health.version == "2.3.76", !health.setupRequired, !health.setupTokenRequired else {
            throw QAError.guardFailed("Synthetic fixture health or version guard failed.")
        }
        let baseline: Arrival = try await readJSON(probeURL)
        try validate(baseline, instance: instance, revision: revision)
        guard baseline.loginSuccessCount < Int.max else { throw QAError.guardFailed("Invalid fixture arrival counter.") }
        let preUI: Arrival = try await readJSON(probeURL)
        try validate(preUI, instance: instance, revision: revision)
        try ArrivalReadPolicy.requireStable(baseline, preUI, expectedCount: baseline.loginSuccessCount)

        safariStarted = true
        safari.open(origin)
        XCTAssertEqual(safari.state, .runningForeground)
        try rejectUnexpectedPrompts(in: safari)
        let web = safari.webViews.firstMatch
        XCTAssertTrue(web.waitForExistence(timeout: 20))
        let username = web.textFields["Username"]
        let password = web.secureTextFields["Password"]
        XCTAssertTrue(username.waitForExistence(timeout: 15))
        XCTAssertTrue(username.isHittable)
        XCTAssertTrue(password.isHittable)
        guard username.value as? String == "" || username.value as? String == "Username" else {
            throw QAError.guardFailed("Fresh blank fixture login is required; existing profiles are not reused.")
        }
        username.tap()
        username.typeText("fixture-owner")
        XCTAssertEqual(username.value as? String, "fixture-owner")
        try rejectUnexpectedPrompts(in: safari)
        password.tap()
        // Public synthetic fixture value, never a user or provider credential.
        password.typeText("fixture-owner-password")
        try rejectUnexpectedPrompts(in: safari)
        let signIn = web.buttons["Sign in"]
        XCTAssertTrue(signIn.isHittable)
        signIn.tap()
        try await dismissKnownWelcomeTour(in: web)
        let watchlist = web.buttons["Watchlist"]
        XCTAssertTrue(watchlist.waitForExistence(timeout: 20))
        XCTAssertTrue(watchlist.isHittable)
        watchlist.tap()
        try rejectUnexpectedPrompts(in: safari)
        try await requireSettledWatchlist(in: web)

        var arrived = false
        for _ in 0..<40 {
            let after: Arrival = try await readJSON(probeURL)
            try validate(after, instance: instance, revision: revision)
            guard after.loginSuccessCount <= baseline.loginSuccessCount + 1 else {
                throw QAError.guardFailed("Concurrent fixture login activity makes attribution ambiguous.")
            }
            if after.loginSuccessCount == baseline.loginSuccessCount + 1 {
                let postUI: Arrival = try await readJSON(probeURL)
                try validate(postUI, instance: instance, revision: revision)
                try ArrivalReadPolicy.requireStable(after, postUI, expectedCount: baseline.loginSuccessCount + 1)
                arrived = true
                break
            }
            try await Task.sleep(nanoseconds: 250_000_000)
        }
        XCTAssertTrue(arrived, "Actual normal Sign in must independently increment the fixture success count exactly once.")
        XCTAssertEqual(safari.state, .runningForeground)
        XCTAssertTrue(watchlist.isHittable)
        try await requireSettledWatchlist(in: web)
        keepScreenshot(safari, name: "safari-fixture-login-and-watchlist")
    }

    private func welcomeTourPresent(in web: XCUIElement) -> Bool {
        web.descendants(matching: .any).matching(identifier: "Welcome tour").firstMatch.exists ||
            web.staticTexts["Welcome to YAWF Stream"].exists || web.buttons["Skip the tour"].exists
    }

    private func dismissKnownWelcomeTour(in web: XCUIElement) async throws {
        let skip = web.buttons["Skip the tour"]
        if skip.waitForExistence(timeout: 5) {
            try rejectUnexpectedPrompts(in: safari)
            guard web.descendants(matching: .any).matching(identifier: "Welcome tour").firstMatch.exists ||
                    web.staticTexts["Welcome to YAWF Stream"].exists, skip.isHittable else {
                throw QAError.guardFailed("Only the observed nonbinding Welcome tour may be dismissed.")
            }
            skip.tap()
        }
        let deadline = Date().addingTimeInterval(10)
        while welcomeTourPresent(in: web), Date() < deadline { try await Task.sleep(nanoseconds: 250_000_000) }
        guard !welcomeTourPresent(in: web) else { throw QAError.guardFailed("Welcome tour remained after its normal Skip action.") }
    }

    private func watchlistPageObservation(in web: XCUIElement) -> WatchlistPageObservation {
        // Static text plus the unique page subtitle distinguishes the actual
        // h1/page content from the always-present Watchlist navigation button.
        let headings = web.staticTexts.matching(identifier: "Watchlist")
        let descriptions = web.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Titles you've saved to watch later."))
        let movies = web.buttons.matching(identifier: "Synthetic Fixture Movie")
        return WatchlistPageObservation(welcomeTourPresent: welcomeTourPresent(in: web),
            headingCount: headings.count, headingVisible: headings.count == 1 && headings.firstMatch.isHittable,
            descriptionCount: descriptions.count, descriptionVisible: descriptions.count == 1 && descriptions.firstMatch.isHittable,
            movieCount: movies.count, movieVisible: movies.count == 1 && movies.firstMatch.isHittable)
    }

    private func requireSettledWatchlist(in web: XCUIElement) async throws {
        let deadline = Date().addingTimeInterval(15)
        while Date() < deadline {
            try rejectUnexpectedPrompts(in: safari)
            let first = watchlistPageObservation(in: web)
            if WatchlistPagePolicy.isReady(first) {
                try await Task.sleep(nanoseconds: 500_000_000)
                let second = watchlistPageObservation(in: web)
                if WatchlistPagePolicy.isReady(second) {
                    try WatchlistPagePolicy.requireSettled(first, second)
                    return
                }
            }
            try await Task.sleep(nanoseconds: 250_000_000)
        }
        throw QAError.guardFailed("Actual Watchlist heading, page content and synthetic movie did not settle without the tour.")
    }

    private func validate(_ arrival: Arrival, instance: UUID, revision: String) throws {
        guard arrival.schemaVersion == 1, arrival.fixtureInstanceId == instance,
              arrival.sourceRevision == revision, arrival.loginSuccessCount >= 0 else {
            throw QAError.guardFailed("Fixture instance, source or arrival schema mismatch.")
        }
    }

    private func readJSON<T: Decodable>(_ url: URL) async throws -> T {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.urlCache = nil
        configuration.timeoutIntervalForRequest = 5
        configuration.timeoutIntervalForResource = 5
        let session = URLSession(configuration: configuration, delegate: NoRedirect(), delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.cachePolicy = .reloadIgnoringLocalCacheData
        let (data, response) = try await session.data(for: request)
        guard let response = response as? HTTPURLResponse, response.statusCode == 200, data.count <= 4096 else {
            throw QAError.guardFailed("Bounded read-only fixture probe failed; no UI success is inferred.")
        }
        return try JSONDecoder().decode(T.self, from: data)
    }

    private func rejectUnexpectedPrompts(in application: XCUIApplication) throws {
        let binding = NSPredicate(format: "label IN %@", ["Agree", "Agree to Terms", "Accept Terms", "Allow", "Enable UI Automation", "Turn On Developer Mode"])
        guard !application.alerts.firstMatch.exists, !springboard.alerts.firstMatch.exists,
              !application.buttons.matching(binding).firstMatch.exists else {
            throw QAError.guardFailed("Unexpected terms, authorization, privacy or security prompt; no acceptance is permitted.")
        }
    }

    private func keepScreenshot(_ application: XCUIApplication, name: String) {
        let attachment = XCTAttachment(screenshot: application.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}

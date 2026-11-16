import XCTest
import UIKit
import Foundation
import Darwin

private enum QARefusal: Error { case failed(String) }
private final class NoRedirect: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}
private struct Snapshot: Decodable {
    let document: String, event: String, sourceKind: String
    let stream: String?
    let seq: Int, sourceOrdinal: Int, videoOrdinal: Int, frames: Int
    let totalFrames: Int?
    let at: Double, currentTime: Double?, frameMediaTime: Double?, rate: Double
    let sourceLocal: Bool, standalone: Bool, rvfc: Bool, hidden: Bool, paused: Bool, seeking: Bool, mediaError: Bool
}
private struct StateDocument: Decodable { let latest: Snapshot?, firstFrame: Snapshot? }
private struct ObserverState: Decodable { let schemaVersion: Int, failed: Bool, documents: [StateDocument] }

// UI actions are limited to the fresh simulator and normal, observed controls.
// Host-side adjudication, not this UI test, determines decoded playback results.
@MainActor
final class IPadForegroundTests: XCTestCase {
    private let safari = XCUIApplication(bundleIdentifier: "com.apple.mobilesafari")
    private let webapp = XCUIApplication(bundleIdentifier: "com.apple.webapp")
    private let home = XCUIApplication(bundleIdentifier: "com.apple.springboard")
    private var origin = ""
    private var clipName = ""
    private var mode = ""
    private var window = 0
    private var controlToken = ""

    private func need(_ value: @autoclosure () -> Bool, _ code: String) throws {
        if !value() { throw QARefusal.failed(code) }
    }
    private func finite(_ frame: CGRect) -> Bool {
        [frame.minX, frame.minY, frame.width, frame.height].allSatisfy { $0.isFinite } && frame.width > 0 && frame.height > 0
    }
    private func owned(_ query: XCUIElementQuery, in container: XCUIElement, label: String) throws -> XCUIElement {
        try need(query.count == 1, "CONTROL_UNIQUE_" + label.replacingOccurrences(of: " ", with: "_"))
        let item = query.element
        try need(item.exists && item.isEnabled && item.isHittable && item.label == label, "CONTROL_ACTIONABLE")
        try need(finite(container.frame) && finite(item.frame) && container.frame.contains(item.frame), "CONTROL_OWNERSHIP")
        return item
    }
    private func button(_ owner: XCUIElement, _ label: String) throws -> XCUIElement {
        try owned(owner.buttons.matching(NSPredicate(format: "label == %@", label)), in: owner, label: label)
    }
    private func wait(_ seconds: Double, _ condition: () -> Bool) async throws {
        let end = ProcessInfo.processInfo.systemUptime + seconds
        while !condition() && ProcessInfo.processInfo.systemUptime < end {
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        try need(condition(), "TIMED_WAIT")
    }
    private func config() throws {
        let e = ProcessInfo.processInfo.environment
        guard let expected = e["QA_EXPECTED_UDID"], UUID(uuidString: expected) != nil,
              e["SIMULATOR_UDID"]?.lowercased() == expected.lowercased(),
              let deviceName = e["QA_EXPECTED_DEVICE_NAME"], !deviceName.isEmpty,
              e["SIMULATOR_DEVICE_NAME"] == deviceName,
              let suppliedOrigin = e["QA_ORIGIN"], let url = URL(string: suppliedOrigin),
              url.scheme == "http", url.host == "127.0.0.1", url.port == 43120,
              url.path.isEmpty, url.query == nil, url.fragment == nil, url.user == nil, url.password == nil,
              let token = e["QA_CONTROL_TOKEN"], token.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil,
              let title = e["QA_CLIP_NAME"], title.range(of: "^[A-Za-z0-9]{3,20}$", options: .regularExpression) != nil,
              let selected = e["QA_MEDIA"], let rawWindow = e["QA_WINDOW_SECONDS"], let seconds = Int(rawWindow),
              (selected == "direct" && (seconds == 15 || seconds == 480)) ||
              (selected == "hls" && (seconds == 15 || seconds == 480)) ||
              (selected == "stall" && seconds == 180)
        else { throw QARefusal.failed("ADMITTED_DYNAMIC_CONFIGURATION_REQUIRED") }
        try need(UIDevice.current.userInterfaceIdiom == .pad && UIDevice.current.systemVersion == "26.5", "IPAD_RUNTIME_REQUIRED")
        origin = suppliedOrigin; clipName = title; mode = selected; window = seconds; controlToken = token
        continueAfterFailure = false
        executionTimeAllowance = 900
    }
    private func web(_ app: XCUIApplication) throws -> XCUIElement {
        try need(app.state == .runningForeground && app.alerts.count == 0, "FOREGROUND_OWNER_REQUIRED")
        let views = app.webViews
        try need(views.count > 0 && views.count <= 3, "WEBVIEW_CENSUS")
        var leaves: [XCUIElement] = []
        for i in 0..<views.count {
            let candidate = views.element(boundBy: i)
            if candidate.exists && candidate.webViews.count == 0 && candidate.isHittable && finite(candidate.frame) && app.frame.contains(candidate.frame) {
                leaves.append(candidate)
            }
        }
        try need(leaves.count == 1, "OWNED_WEBVIEW_REQUIRED")
        return leaves[0]
    }
    private func form(_ expectedName: String) -> (XCUIElement, XCUIElement)? {
        guard safari.state == .runningForeground && safari.alerts.count == 0 else { return nil }
        let bars = safari.navigationBars.matching(NSPredicate(format: "identifier == %@", "Add to Home Screen"))
        let tables = safari.tables
        guard bars.count == 1 && tables.count == 1 else { return nil }
        let bar = bars.element, table = tables.element
        guard bar.exists && table.exists && finite(bar.frame) && finite(table.frame) && safari.frame.contains(table.frame) && table.frame.contains(bar.frame) else { return nil }
        let fields = table.textFields
        let origins = table.staticTexts.matching(NSPredicate(format: "label == %@", origin + "/"))
        let switches = table.switches.matching(NSPredicate(format: "label == %@", "Open as Web App"))
        guard fields.count == 1 && origins.count == 1 && switches.count == 1 else { return nil }
        let field = fields.element, link = origins.element, toggle = switches.element
        guard field.exists && field.isEnabled && field.isHittable && (field.value as? String) == expectedName &&
                field.debugDescription.contains("Keyboard Focused") && finite(field.frame) && table.frame.contains(field.frame) &&
                link.exists && finite(link.frame) && table.frame.contains(link.frame) &&
                toggle.exists && (toggle.value as? String) == "1" && finite(toggle.frame) && table.frame.contains(toggle.frame) else { return nil }
        return (bar, field)
    }
    private func sheetAction(_ label: String) throws -> XCUIElement {
        let sheets = safari.otherElements.matching(NSPredicate(format: "identifier == %@", "ShareSheet.RemoteContainerView"))
        try need(sheets.count == 1 && sheets.element.exists && finite(sheets.element.frame) && safari.frame.contains(sheets.element.frame), "CURRENT_SHARE_SHEET")
        return try owned(sheets.element.cells.matching(NSPredicate(format: "identifier == %@ AND label == %@", "actionGroupCell", label)), in: sheets.element, label: label)
    }
    private func install() async throws {
        XCUIDevice.shared.press(.home)
        try need(home.wait(for: .runningForeground, timeout: 10), "FRESH_HOME_REQUIRED")
        try need(home.icons.matching(NSPredicate(format: "label == %@", clipName)).count == 0, "CLIP_ALREADY_EXISTS")
        safari.launch()
        try need(safari.wait(for: .runningForeground, timeout: 15) && safari.alerts.count == 0, "SAFARI_START")
        safari.typeKey("t", modifierFlags: .command)
        safari.typeKey("l", modifierFlags: .command)
        let addresses = safari.textFields.matching(NSPredicate(format: "identifier BEGINSWITH %@ AND label == %@", "SearchFieldItemView?", "Address"))
        try await wait(5) { addresses.count == 1 && addresses.element.exists }
        try need(addresses.element.debugDescription.contains("Keyboard Focused"), "ADDRESS_FOCUS_REQUIRED")
        addresses.element.typeText(origin + "/\n")
        try await wait(20) { (try? self.web(self.safari).staticTexts.matching(NSPredicate(format: "label == %@", self.origin)).count) == 1 }
        let owner = try web(safari)
        _ = try owned(owner.staticTexts.matching(NSPredicate(format: "label == %@", origin)), in: owner, label: origin)
        try button(safari, "Share").tap()
        try await wait(5) { (try? self.sheetAction("View More")) != nil }
        try sheetAction("View More").tap()
        try await wait(5) { (try? self.sheetAction("Add to Home Screen")) != nil }
        try sheetAction("Add to Home Screen").tap()
        try await wait(8) { self.form("YAWF Stream") != nil }
        guard let (_, field) = form("YAWF Stream") else { throw QARefusal.failed("INSTALL_FORM") }
        try owned(field.buttons.matching(NSPredicate(format: "label == %@", "Clear text")), in: field, label: "Clear text").tap()
        try await wait(3) { self.form("") != nil }
        guard let (_, emptyField) = form("") else { throw QARefusal.failed("EMPTY_INSTALL_NAME") }
        emptyField.typeText(clipName)
        try await wait(3) { self.form(self.clipName) != nil }
        guard let (bar, _) = form(clipName) else { throw QARefusal.failed("INSTALL_CONFIRMATION") }
        try button(bar, "Add").tap()
        if home.state != .runningForeground { XCUIDevice.shared.press(.home) }
        try need(home.wait(for: .runningForeground, timeout: 10), "HOME_AFTER_ADD")
        let icons = home.icons.matching(NSPredicate(format: "label == %@", clipName))
        try await wait(10) { icons.count == 1 && icons.element.exists && icons.element.isHittable }
        try owned(icons, in: home, label: clipName).tap()
        try need(webapp.wait(for: .runningForeground, timeout: 15), "INSTALLED_WEBAPP_OWNER")
    }
    private func login() async throws {
        try await wait(20) { (try? self.web(self.webapp).textFields.matching(NSPredicate(format: "label == %@", "Username")).count) == 1 }
        let owner = try web(webapp)
        _ = try owned(owner.staticTexts.matching(NSPredicate(format: "label == %@", origin)), in: owner, label: origin)
        let username = try owned(owner.textFields.matching(NSPredicate(format: "label == %@", "Username")), in: owner, label: "Username")
        let password = try owned(owner.secureTextFields.matching(NSPredicate(format: "label == %@", "Password")), in: owner, label: "Password")
        try need([nil, "", "Username"].contains(username.value as? String) && [nil, "", "Password"].contains(password.value as? String), "FRESH_LOGIN_FIELDS")
        username.tap(); username.typeText("fixture-owner")
        password.tap(); password.typeText("fixture-owner-password")
        try button(owner, "Sign in").tap()
        // The only system prompt admitted here is the exact observed password dialog.
        let promptEnd = ProcessInfo.processInfo.systemUptime + 3
        while webapp.alerts.count == 0 && ProcessInfo.processInfo.systemUptime < promptEnd { try await Task.sleep(nanoseconds: 100_000_000) }
        if webapp.alerts.count != 0 {
            try need(webapp.alerts.count == 1 && webapp.alerts.element.label == "Save Password?", "UNKNOWN_SYSTEM_ALERT")
            try button(webapp.alerts.element, "Not Now").tap()
            try await wait(4) { self.webapp.alerts.count == 0 }
        }
        try await wait(40) { (try? self.web(self.webapp).buttons.matching(NSPredicate(format: "label == %@", "Skip the tour")).count) == 1 }
        let current = try web(webapp)
        let tour = current.otherElements.matching(NSPredicate(format: "label == %@", "Welcome tour, web dialog"))
        try need(tour.count == 1 && tour.element.exists && current.frame.contains(tour.element.frame), "WELCOME_TOUR_OWNER")
        try button(tour.element, "Skip the tour").tap()
        try await wait(10) { (try? self.web(self.webapp).buttons.matching(NSPredicate(format: "label == %@", "Settings")).count) == 1 }
    }
    private func nativeMode() async throws {
        var owner = try web(webapp)
        try button(owner, "Settings").tap()
        let category = owner.otherElements.matching(NSPredicate(format: "label == %@ AND value == %@", "SETTINGS CATEGORY", "Install & setup"))
        try await wait(15) { category.count == 1 && category.element.isHittable }
        try owned(category, in: owner, label: "SETTINGS CATEGORY").tap()
        let collections = webapp.collectionViews
        try await wait(5) { collections.count == 1 && collections.element.exists }
        try button(collections.element, "Playback").tap()
        try await wait(10) { owner.otherElements.matching(NSPredicate(format: "label == %@ AND value == %@", "SETTINGS CATEGORY", "Playback")).count == 1 }
        owner = try web(webapp)
        let engines = owner.otherElements.matching(NSPredicate(format: "label == %@", "iPhone and iPad HLS playback"))
        let engine = try owned(engines, in: owner, label: "iPhone and iPad HLS playback")
        try need(["Native, with AirPlay", "Compatibility mode"].contains(engine.value as? String ?? ""), "KNOWN_NATIVE_ENGINE")
        engine.tap()
        try await wait(5) { collections.count == 1 && collections.element.exists }
        try button(collections.element, "Native, with AirPlay").tap()
        let changed = owner.otherElements.matching(NSPredicate(format: "label == %@ AND value == %@", "iPhone and iPad HLS playback", "Native, with AirPlay"))
        try await wait(5) { changed.count == 1 && changed.element.exists }
        let save = owner.buttons.matching(NSPredicate(format: "label == %@", "Save changes"))
        try need(save.count <= 1, "SAVE_AMBIGUOUS")
        if save.count == 1 && save.element.isEnabled { try owned(save, in: owner, label: "Save changes").tap() }
        let done = owner.buttons.matching(NSPredicate(format: "label == %@ OR label == %@", "Saved", "Up to date"))
        try await wait(15) { done.count == 1 && !done.element.isEnabled && changed.count == 1 }
    }
    private func openPlayer() async throws {
        var owner = try web(webapp)
        try button(owner, "Watchlist").tap()
        let movie = owner.buttons.matching(NSPredicate(format: "label == %@", "Synthetic Fixture Movie"))
        try await wait(20) { movie.count == 1 && movie.element.isHittable }
        try owned(movie, in: owner, label: "Synthetic Fixture Movie").tap()
        owner = try web(webapp)
        let details = owner.otherElements.matching(NSPredicate(format: "label == %@ OR label == %@", "Synthetic Fixture Movie details", "Synthetic Fixture Movie details, web dialog"))
        try await wait(20) { details.count == 1 && details.element.exists }
        let detail = details.element
        try need(finite(detail.frame) && owner.frame.contains(detail.frame), "DETAIL_OWNER")
        let sources = detail.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Synthetic Fixture Movie 2026 1080p WEB-DL x264"))
        for _ in 0..<3 {
            if sources.count == 1 && sources.element.isHittable { break }
            detail.swipeUp()
            let all = detail.buttons.matching(NSPredicate(format: "label == %@", "Show all streams"))
            try need(all.count <= 1, "STREAM_LIST_AMBIGUOUS")
            if all.count == 1 && all.element.isHittable { try button(detail, "Show all streams").tap() }
        }
        try await wait(30) { sources.count == 1 && sources.element.isHittable }
        try owned(sources, in: detail, label: sources.element.label).tap()
        let player = owner.otherElements.matching(NSPredicate(format: "label == %@", "Playing Synthetic Fixture Movie (2026), web dialog"))
        try await wait(30) { player.count == 1 && player.element.exists }
        try need(owner.frame.contains(player.element.frame), "PLAYER_OWNER")
    }
    private func select480() async throws {
        let deadline = ProcessInfo.processInfo.systemUptime + 90
        var qualityTapped = false, reveals = 0, opens = 0
        var lastOpen = -Double.infinity
        while ProcessInfo.processInfo.systemUptime < deadline {
            if let owner = try? web(webapp) {
                let dialogs = owner.otherElements.matching(NSPredicate(format: "label == %@", "Playing Synthetic Fixture Movie (2026), web dialog"))
                try need(dialogs.count <= 1, "PLAYER_FOR_QUALITY_AMBIGUOUS")
                let menus = owner.otherElements.matching(NSPredicate(format: "label == %@ OR label == %@", "Playback settings", "Playback settings, web dialog"))
                try need(menus.count <= 1, "QUALITY_MENU_AMBIGUOUS")
                if menus.count == 1 && menus.element.exists {
                    let menu = menus.element
                    try need(finite(menu.frame) && owner.frame.contains(menu.frame), "QUALITY_MENU_OWNER")
                    let quality = menu.buttons.matching(NSPredicate(format: "label == %@", "480p"))
                    try need(quality.count <= 1, "QUALITY_CHOICE_AMBIGUOUS")
                    if quality.count == 1 && quality.element.exists && quality.element.isHittable {
                        let item = try owned(quality, in: menu, label: "480p")
                        if item.isSelected || (item.value as? String) == "1" {
                            try button(menu, "Close playback settings").tap()
                            let closeEnd = min(deadline, ProcessInfo.processInfo.systemUptime + 5)
                            while ProcessInfo.processInfo.systemUptime < closeEnd {
                                if let fresh = try? web(webapp), fresh.otherElements.matching(NSPredicate(format: "label == %@ OR label == %@", "Playback settings", "Playback settings, web dialog")).count == 0 { return }
                                try await Task.sleep(nanoseconds: 100_000_000)
                            }
                            throw QARefusal.failed("QUALITY_MENU_CLOSE_REQUIRED")
                        }
                        if !qualityTapped {
                            qualityTapped = true
                            item.tap()
                        }
                    }
                } else if dialogs.count == 1 && dialogs.element.exists {
                    let dialog = dialogs.element
                    try need(finite(dialog.frame) && owner.frame.contains(dialog.frame), "PLAYER_FOR_QUALITY")
                    let settings = dialog.buttons.matching(NSPredicate(format: "label == %@", "Playback settings"))
                    try need(settings.count <= 1, "QUALITY_SETTINGS_AMBIGUOUS")
                    if settings.count == 1 && settings.element.isHittable && ProcessInfo.processInfo.systemUptime - lastOpen >= 1 {
                        try need(opens < 4, "QUALITY_MENU_REOPEN_LIMIT")
                        try owned(settings, in: dialog, label: "Playback settings").tap()
                        opens += 1
                        lastOpen = ProcessInfo.processInfo.systemUptime
                    } else if (settings.count == 0 || !settings.element.isHittable) && reveals < 2 {
                        dialog.tap()
                        reveals += 1
                    }
                }
            }
            try await Task.sleep(nanoseconds: 250_000_000)
        }
        throw QARefusal.failed("QUALITY_SELECTION_DEADLINE")
    }
    private func screenshot(_ name: String, playerFrame: CGRect, appFrame: CGRect) throws {
        let screen = XCUIScreen.main.screenshot().image
        guard let image = screen.cgImage else { throw QARefusal.failed("PIXEL_ANCHOR_UNAVAILABLE") }
        try need(finite(playerFrame) && finite(appFrame) && appFrame.contains(playerFrame), "PIXEL_ANCHOR_OWNER")
        let sx = CGFloat(image.width) / appFrame.width, sy = CGFloat(image.height) / appFrame.height
        let rect = CGRect(x: (playerFrame.minX - appFrame.minX) * sx, y: (playerFrame.minY - appFrame.minY) * sy,
                          width: playerFrame.width * sx, height: playerFrame.height * sy).integral
        try need(rect.minX >= 0 && rect.minY >= 0 && rect.maxX <= CGFloat(image.width) && rect.maxY <= CGFloat(image.height) &&
                 rect.width >= 100 && rect.height >= 100 && rect.width <= 4096 && rect.height <= 4096, "PIXEL_ANCHOR_GEOMETRY")
        guard let cropped = image.cropping(to: rect), let data = UIImage(cgImage: cropped).pngData(), data.count <= 5 * 1024 * 1024 else {
            throw QARefusal.failed("PIXEL_ANCHOR_SIZE")
        }
        let attachment = XCTAttachment(data: data, uniformTypeIdentifier: "public.png")
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
    private func observerState() async throws -> ObserverState {
        guard let url = URL(string: origin + "/__ipadqa/state") else { throw QARefusal.failed("STATE_URL") }
        let config = URLSessionConfiguration.ephemeral
        config.httpCookieStorage = nil; config.urlCredentialStorage = nil; config.urlCache = nil
        config.timeoutIntervalForRequest = 3; config.timeoutIntervalForResource = 3
        let session = URLSession(configuration: config, delegate: NoRedirect(), delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        var request = URLRequest(url: url)
        request.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        request.setValue(controlToken, forHTTPHeaderField: "X-IPad-QA-Control")
        let (data, response) = try await session.data(for: request)
        try need((response as? HTTPURLResponse)?.statusCode == 200 && response.url == url && data.count <= 16 * 1024, "STATE_HTTP")
        let state = try JSONDecoder().decode(ObserverState.self, from: data)
        try need(state.schemaVersion == 1 && !state.failed && state.documents.count <= 8, "STATE_INSTRUMENTATION_GAP")
        return state
    }
    private func decodedReady() async throws -> Snapshot {
        let end = ProcessInfo.processInfo.systemUptime + 120
        let requiredKind = mode == "direct" ? "direct" : "hls"
        while ProcessInfo.processInfo.systemUptime < end {
            let state = try await observerState()
            let standalone = state.documents.filter { $0.latest?.standalone == true }
            try need(standalone.count <= 1, "MULTIPLE_STANDALONE_DOCUMENTS")
            if let doc = standalone.first, let latest = doc.latest, let first = doc.firstFrame,
               latest.document == first.document && latest.videoOrdinal == first.videoOrdinal &&
               latest.sourceOrdinal == first.sourceOrdinal && latest.sourceKind == requiredKind && first.sourceKind == requiredKind &&
               latest.stream != nil && latest.stream == first.stream && latest.seq >= first.seq &&
               latest.standalone && first.standalone && latest.sourceLocal && first.sourceLocal && latest.rvfc && first.rvfc &&
               !latest.hidden && !latest.paused && !latest.seeking && !latest.mediaError && latest.rate == 1 &&
               first.frames > 0 && first.frameMediaTime != nil && (latest.totalFrames ?? 0) > 0 &&
               (latest.currentTime ?? 0) > 0 {
                return latest
            }
            try await Task.sleep(nanoseconds: 200_000_000)
        }
        throw QARefusal.failed("FRESH_NATIVE_FIRST_FRAME_REQUIRED")
    }
    private func deliveredWindow(_ baseline: Snapshot) async throws {
        guard let initialTime = baseline.currentTime, let initialTotal = baseline.totalFrames else {
            throw QARefusal.failed("WINDOW_BASELINE_INCOMPLETE")
        }
        let deadline = ProcessInfo.processInfo.systemUptime + 8
        while ProcessInfo.processInfo.systemUptime < deadline {
            let state = try await observerState()
            let matching = state.documents.compactMap { $0.latest }.filter { $0.document == baseline.document }
            try need(matching.count <= 1, "WINDOW_DOCUMENT_AMBIGUOUS")
            if let now = matching.first {
                try need(now.videoOrdinal == baseline.videoOrdinal && now.sourceOrdinal == baseline.sourceOrdinal &&
                         now.sourceKind == baseline.sourceKind && now.stream == baseline.stream && now.standalone &&
                         now.sourceLocal && now.rvfc && !now.hidden && !now.paused && !now.seeking && !now.mediaError && now.rate == 1,
                         "WINDOW_IDENTITY_OR_PLAYER_CHANGED")
                if now.seq > baseline.seq && now.at - baseline.at >= Double(window) * 1000 &&
                   (now.currentTime ?? -1) - initialTime >= Double(window) &&
                   (now.totalFrames ?? 0) > initialTotal && now.frames > baseline.frames { return }
            }
            try await Task.sleep(nanoseconds: 200_000_000)
        }
        throw QARefusal.failed("FULL_WINDOW_OBSERVATION_REQUIRED")
    }
    func testInstalledPwaForeground() async throws {
        try config()
        try await install()
        try await login()
        try await nativeMode()
        try await openPlayer()
        if mode != "direct" { try await select480() }
        try need(webapp.state == .runningForeground, "WEBAPP_BEFORE_WINDOW")
        let baseline = try await decodedReady()
        let owner = try web(webapp)
        let players = owner.otherElements.matching(NSPredicate(format: "label == %@", "Playing Synthetic Fixture Movie (2026), web dialog"))
        try need(players.count == 1 && players.element.exists && owner.frame.contains(players.element.frame), "PIXEL_PLAYER_OWNER")
        let playerFrame = players.element.frame, appFrame = webapp.frame
        print("IPAD_QA_WINDOW_BEGIN_\(mode.uppercased())_\(window)_\(baseline.document)_\(baseline.seq)_\(baseline.sourceOrdinal)")
        fflush(stdout)
        // Startup readiness is separate. Host adjudication checks the actual
        // presented, total-frame, media-clock, producer and route observations.
        let captureSeconds = window
        let started = ProcessInfo.processInfo.systemUptime
        var next = 0
        while next < captureSeconds {
            let target = started + Double(next)
            let delay = target - ProcessInfo.processInfo.systemUptime
            if delay > 0 { try await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000)) }
            try screenshot("native-\(mode)-\(next)", playerFrame: playerFrame, appFrame: appFrame)
            next += mode == "stall" ? 60 : 120
        }
        let remaining = started + Double(captureSeconds) - ProcessInfo.processInfo.systemUptime
        if remaining > 0 { try await Task.sleep(nanoseconds: UInt64(remaining * 1_000_000_000)) }
        if mode != "stall" { try await deliveredWindow(baseline) }
        try screenshot("native-\(mode)-end", playerFrame: playerFrame, appFrame: appFrame)
        let elapsed = ProcessInfo.processInfo.systemUptime - started
        try need(elapsed >= Double(window) && elapsed < Double(window) + 15, "WALL_WINDOW_BOUND")
        try need(webapp.state == .runningForeground, "WEBAPP_AFTER_WINDOW")
        print("IPAD_QA_WINDOW_END_\(mode.uppercased())_\(window)")
        fflush(stdout)
        // No playback pass is asserted here. The host evaluates private event,
        // producer, manifest, decoded-clock, and held-segment evidence separately.
    }
}

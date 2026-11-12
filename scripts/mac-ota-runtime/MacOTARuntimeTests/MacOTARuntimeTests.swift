import AppKit
import Darwin
import Foundation
import XCTest

final class MacOTARuntimeTests: XCTestCase {
    private struct Configuration: Decodable {
        let appPath: String
        let expectedBeforeVersion: String
        let expectedAfterVersion: String
    }

    private struct Receipt: Encodable {
        let appPath: String
        let beforePID: Int32
        let afterPID: Int32
        let beforeExecutablePath: String
        let afterExecutablePath: String
        let beforeVersion: String
        let afterVersion: String
        let profileName: String
        let density: String
        let watchlistTitle: String
        let preInstallReopenUsed: Bool
        let normalQuitObserved: Bool
    }

    private struct PublicElementAttributes: Encodable {
        let type: String
        let index: Int
        let title: String
        let label: String
        let value: String
        let enabled: Bool
        let hittable: Bool
    }

    private enum AdmissionError: LocalizedError {
        case refused(String)

        var errorDescription: String? {
            switch self {
            case .refused(let reason): return reason
            }
        }
    }

    private func runtimeAdmissionRefusal(environment: [String: String]) -> String? {
        let environmentChecks = [
            "CI": environment["CI"] == "true",
            "GITHUB_ACTIONS": environment["GITHUB_ACTIONS"] == "true",
            "RUNNER_ENVIRONMENT": environment["RUNNER_ENVIRONMENT"] == "github-hosted",
            "RUNNER_OS": environment["RUNNER_OS"] == "macOS",
            "RUNNER_ARCH": environment["RUNNER_ARCH"] == "ARM64",
            "RUNNER_TEMP": environment["RUNNER_TEMP"] == "/Users/runner/work/_temp",
        ]
        let failedEnvironmentChecks = environmentChecks.filter { !$0.value }.map { "\($0.key)=false" }.sorted()
        guard failedEnvironmentChecks.isEmpty else {
            return "GitHub-hosted runner environment admission failed: \(failedEnvironmentChecks.joined(separator: ", "))."
        }
#if os(macOS) && arch(arm64)
        let version = ProcessInfo.processInfo.operatingSystemVersion
        guard version.majorVersion == 15, kernelRelease()?.hasPrefix("24.") == true else {
            return "Actual macOS 15 and Darwin 24 are required."
        }
        var arm64 = Int32(0)
        var arm64Size = MemoryLayout.size(ofValue: arm64)
        let arm64Status = "hw.optional.arm64".withCString {
            sysctlbyname($0, &arm64, &arm64Size, nil, 0)
        }
        guard arm64Status == 0, arm64 == 1 else {
            return "Actual Apple arm64 hardware is required."
        }
        let uid = getuid()
        guard uid == geteuid(), let account = getpwuid(uid) else {
            return "The current login account could not be verified."
        }
        let username = String(cString: account.pointee.pw_name)
        let home = String(cString: account.pointee.pw_dir)
        let resolvedHome = URL(fileURLWithPath: home, isDirectory: true).resolvingSymlinksInPath().path
        guard username == "runner", home == "/Users/runner", resolvedHome == "/Users/runner" else {
            return "The actual GitHub-hosted runner account is required."
        }
        return nil
#else
        return "The UI test binary must execute as macOS arm64."
#endif
    }

    private func kernelRelease() -> String? {
        var information = utsname()
        guard uname(&information) == 0 else { return nil }
        let capacity = MemoryLayout.size(ofValue: information.release)
        return withUnsafePointer(to: &information.release) { pointer in
            pointer.withMemoryRebound(to: CChar.self, capacity: capacity) {
                String(cString: $0)
            }
        }
    }

    override func setUpWithError() throws {
        continueAfterFailure = false
        let environment = ProcessInfo.processInfo.environment
        if let reason = runtimeAdmissionRefusal(environment: environment) {
            XCTFail(reason)
            throw AdmissionError.refused(reason)
        }
    }

    @MainActor
    func testPublic96To102ThroughNormalUpdaterUI() throws {
        let config = try loadConfiguration()
        let configuredAppURL = URL(fileURLWithPath: config.appPath, isDirectory: true).standardizedFileURL
        let appURL = configuredAppURL.resolvingSymlinksInPath().standardizedFileURL
        let runnerTemp = try XCTUnwrap(ProcessInfo.processInfo.environment["RUNNER_TEMP"])
        let configuredRunnerTempURL = URL(fileURLWithPath: runnerTemp, isDirectory: true).standardizedFileURL
        let runnerTempURL = configuredRunnerTempURL.resolvingSymlinksInPath().standardizedFileURL
        guard configuredRunnerTempURL == runnerTempURL else {
            throw AdmissionError.refused("RUNNER_TEMP resolves through a symlinked ancestor.")
        }
        guard configuredAppURL == appURL else {
            throw AdmissionError.refused("The candidate app path or one of its ancestors is a symlink.")
        }
        guard appURL.path.hasPrefix(runnerTempURL.path + "/") else {
            throw AdmissionError.refused("The candidate app must remain beneath RUNNER_TEMP.")
        }
        let resourceValues = try appURL.resourceValues(forKeys: [.isSymbolicLinkKey, .isDirectoryKey])
        XCTAssertEqual(resourceValues.isDirectory, true)
        XCTAssertNotEqual(resourceValues.isSymbolicLink, true)
        XCTAssertEqual(try bundleVersion(appURL), config.expectedBeforeVersion)
        guard NSWorkspace.shared.runningApplications.allSatisfy({ $0.bundleIdentifier != "com.tgk30.debridstreamer" }) else {
            throw AdmissionError.refused("No process with the YAWF Stream bundle identifier may predate this isolated run.")
        }

        var activeApp = XCUIApplication(url: appURL)
        activeApp.launch()
        XCTAssertTrue(activeApp.wait(for: .runningForeground, timeout: 30))
        var installOwner = try uniqueRunningApplication(at: appURL)

        captureInitialPublicAttributes(in: activeApp)
        try dismissInitialWelcome(in: activeApp)
        try completeQuickSetup(in: activeApp)
        try seedCompactDensity(in: activeApp)
        try seedProfileName(in: activeApp, name: "OTA Runner")
        try seedWatchlist(in: activeApp, title: "Inception")

        var preInstallReopenUsed = false
        capturePhase("update-offer-before-first-query", in: activeApp)
        if try findUpdateOffer(in: activeApp, expectedVersion: config.expectedAfterVersion, timeout: 180) == nil {
            capturePhase("update-offer-before-reopen", in: activeApp)
            preInstallReopenUsed = true
            activeApp.typeKey("q", modifierFlags: .command)
            XCTAssertTrue(activeApp.wait(for: .notRunning, timeout: 30), "The baseline app did not stop through its normal Quit command before retrying its launch check.")
            XCTAssertEqual(try bundleVersion(appURL), config.expectedBeforeVersion)
            activeApp = XCUIApplication(url: appURL)
            activeApp.launch()
            XCTAssertTrue(activeApp.wait(for: .runningForeground, timeout: 30))
            installOwner = try uniqueRunningApplication(at: appURL)
            capturePhase("update-offer-after-reopen-before-query", in: activeApp)
            guard try findUpdateOffer(in: activeApp, expectedVersion: config.expectedAfterVersion, timeout: 180) != nil else {
                capturePhase("update-offer-missing-after-reopen", in: activeApp)
                throw AdmissionError.refused("The exact split-text update notice was unavailable after the normal reopen.")
            }
        }
        capturePhase("05-update-offer", in: activeApp)
        let beforeExecutablePath = try XCTUnwrap(installOwner.executableURL).path
        let install = try uniqueHittable(named(activeApp.buttons, "Install"), label: "Install", timeout: 15)
        guard let notice = try findUpdateOffer(in: activeApp, expectedVersion: config.expectedAfterVersion, timeout: 15) else {
            capturePhase("update-offer-missing-before-install", in: activeApp)
            throw AdmissionError.refused("The update notice was not freshly witnessed before Install.")
        }
        let installFrame = install.frame
        guard named(activeApp.buttons, "Install").count == 1, install.isHittable, Self.usableNoticeFrame(installFrame), installFrame == notice.installFrame, notice.frame.contains(installFrame), notice.windowFrame.contains(installFrame) else {
            throw AdmissionError.refused("The unique Install control was not contained in the freshly witnessed update notice.")
        }
        install.click()
        XCTAssertTrue(waitUntil(timeout: 600) {
            installOwner.isTerminated || self.textPrefixExists(activeApp.staticTexts, prefix: "Installing")
        }, "Neither installation progress nor the updater-owned process exit was observed after the single Install action.")

        XCTAssertTrue(waitUntil(timeout: 600) { installOwner.isTerminated })
        let after = try waitForReplacementApplication(at: appURL, excluding: installOwner.processIdentifier, timeout: 120)
        let afterExecutablePath = try XCTUnwrap(after.executableURL).path
        XCTAssertNotEqual(installOwner.processIdentifier, after.processIdentifier)
        XCTAssertEqual(after.bundleURL?.standardizedFileURL, appURL)
        XCTAssertEqual(after.executableURL?.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().standardizedFileURL, appURL)
        XCTAssertEqual(try bundleVersion(appURL), config.expectedAfterVersion)

        let relaunched = XCUIApplication(url: appURL)
        XCTAssertTrue(relaunched.wait(for: .runningForeground, timeout: 30), "The updater must relaunch the app; the test must not launch it a second time.")

        try assertProfileName(in: relaunched, name: "OTA Runner")
        try assertCompactDensity(in: relaunched)
        try assertWatchlist(in: relaunched, title: "Inception")
        capturePhase("06-postupdate-state", in: relaunched)

        relaunched.typeKey("q", modifierFlags: .command)
        XCTAssertTrue(relaunched.wait(for: .notRunning, timeout: 30), "The private app did not stop through its normal Quit command.")

        let receipt = Receipt(
            appPath: appURL.path,
            beforePID: installOwner.processIdentifier,
            afterPID: after.processIdentifier,
            beforeExecutablePath: beforeExecutablePath,
            afterExecutablePath: afterExecutablePath,
            beforeVersion: config.expectedBeforeVersion,
            afterVersion: config.expectedAfterVersion,
            profileName: "OTA Runner",
            density: "Compact",
            watchlistTitle: "Inception",
            preInstallReopenUsed: preInstallReopenUsed,
            normalQuitObserved: true
        )
        try attachReceipt(receipt)
    }

    @MainActor
    private func dismissInitialWelcome(in app: XCUIApplication) throws {
        let welcomeQuery = named(app.groups, "Welcome")
        let welcome = try uniqueExisting(welcomeQuery, label: "initial Welcome group", timeout: 60)
        _ = try uniqueStaticText(welcome.staticTexts, text: "Welcome to YAWF Stream", timeout: 30)
        let skip = try uniqueHittable(named(welcome.buttons, "Skip"), label: "initial Welcome Skip", timeout: 30)
        capturePhase("01-initial-welcome", in: app)
        skip.click()
        XCTAssertTrue(waitUntil(timeout: 30) { !welcome.exists }, "The initial Welcome group did not close through its visible Skip control.")
        _ = try uniqueStaticText(app.staticTexts, text: "How do you want to use YAWF Stream?", timeout: 60)
        capturePhase("02-persona-choice", in: app)
    }

    @MainActor
    private func completeQuickSetup(in app: XCUIApplication) throws {
        let quickSetupCopy = "Start with public sources without adding your own keys now. Catalog and playback limits are explained before continuing."
        let quickSetup = try uniqueHittable(
            app.buttons.matching(NSPredicate(format: "(title CONTAINS %@ AND title CONTAINS %@) OR (label CONTAINS %@ AND label CONTAINS %@)", "Quick setup", quickSetupCopy, "Quick setup", quickSetupCopy)),
            label: "Quick setup semantic card",
            timeout: 60
        )
        quickSetup.click()

        _ = try uniqueStaticText(app.staticTexts, text: "Continue without adding credentials", timeout: 30)
        capturePhase("03-quick-privacy", in: app)
        let acknowledgement = try uniqueHittable(
            app.checkBoxes.matching(NSPredicate(format: "title CONTAINS %@ OR label CONTAINS %@", "I understand the privacy, reliability, catalog, and playback limits", "I understand the privacy, reliability, catalog, and playback limits")),
            label: "Quick setup acknowledgement",
            timeout: 15
        )
        if (acknowledgement.value as? String) != "1" { acknowledgement.click() }

        let continueButton = try uniqueHittable(named(app.buttons, "Continue with Quick setup"), label: "Continue with Quick setup", timeout: 15)
        continueButton.click()
        XCTAssertTrue(named(app.buttons, "Discover").firstMatch.waitForExistence(timeout: 60))
        let welcome = named(app.groups, "Welcome tour")
        XCTAssertTrue(welcome.firstMatch.waitForExistence(timeout: 30), "The normal post-setup Welcome tour was not presented.")
        XCTAssertEqual(welcome.count, 1, "The Welcome tour dialog was ambiguous.")
        let skip = try uniqueHittable(named(welcome.firstMatch.buttons, "Skip the tour"), label: "Skip the tour", timeout: 15)
        capturePhase("04-postsetup-tour", in: app)
        skip.click()
        XCTAssertTrue(waitUntil(timeout: 15) { !welcome.firstMatch.exists }, "The Welcome tour did not close through its visible control.")
    }

    @MainActor
    private func selectSettingsCategory(_ category: String, in app: XCUIApplication) throws {
        guard ["Appearance", "Profiles"].contains(category) else {
            throw AdmissionError.refused("Unknown scoped Settings category.")
        }
        let picker = try uniqueHittable(named(app.popUpButtons, "SETTINGS CATEGORY"), label: "Settings category popup", timeout: 30)
        picker.click()
        capturePhase("settings-category-\(category)-menu", in: app)
        let option = try uniqueHittable(named(app.menuItems, category), label: "Settings category option \(category)", timeout: 15)
        option.click()
        let selected = try uniqueHittable(named(app.popUpButtons, "SETTINGS CATEGORY"), label: "selected Settings category popup", timeout: 15)
        XCTAssertTrue(waitUntil(timeout: 15) { (selected.value as? String) == category }, "The visible Settings category value did not match the selected category.")
    }

    @MainActor
    private func seedCompactDensity(in app: XCUIApplication) throws {
        try clickUniqueButton("Settings", in: app)
        try selectSettingsCategory("Appearance", in: app)
        let styles = try uniqueExisting(named(app.groups, "Appearance styles"), label: "Appearance styles group", timeout: 30)
        let compact = try uniqueHittable(named(styles.checkBoxes, "Apply Compact control style"), label: "Apply Compact control style", timeout: 30)
        compact.click()
        try saveSettingsIfEnabled(in: app)
        try assertCompactDensity(in: app)
    }

    @MainActor
    private func seedProfileName(in app: XCUIApplication, name: String) throws {
        try clickUniqueButton("Settings", in: app)
        try selectSettingsCategory("Profiles", in: app)
        app.activate()
        capturePhase("profile-name-before-center", in: app)
        let field = try uniqueHittable(named(app.textFields, "NAME"), label: "fresh NAME profile field", timeout: 30)
        let window = try uniqueExisting(app.windows, label: "private app window", timeout: 15)
        let fieldFrame = field.frame
        let windowFrame = window.frame
        guard name == "OTA Runner", (field.value as? String) == "You",
              !fieldFrame.isNull, !fieldFrame.isInfinite, fieldFrame.width > 0, fieldFrame.height > 0,
              !windowFrame.isNull, !windowFrame.isInfinite, windowFrame.width > 0, windowFrame.height > 0,
              windowFrame.contains(fieldFrame) else {
            throw AdmissionError.refused("The exact fresh NAME field and its contained visible frame were not admitted.")
        }
        field.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).click()
        app.typeKey("a", modifierFlags: .command)
        if let reason = runtimeAdmissionRefusal(environment: ProcessInfo.processInfo.environment) {
            throw AdmissionError.refused(reason)
        }
        let clipboard = NSPasteboard.general
        let clearedChangeCount = clipboard.clearContents()
        defer { _ = clipboard.clearContents() }
        guard clearedChangeCount > 0, clipboard.changeCount == clearedChangeCount,
              clipboard.types?.isEmpty ?? true else {
            throw AdmissionError.refused("The fresh hosted VM clipboard could not be cleared.")
        }
        guard clipboard.setString("OTA Runner", forType: .string),
              clipboard.string(forType: .string) == "OTA Runner" else {
            throw AdmissionError.refused("The fixed fake profile name was not written to the fresh VM clipboard.")
        }
        app.typeKey("v", modifierFlags: .command)
        capturePhase("profile-name-after-paste", in: app)
        guard waitUntil(timeout: 10, condition: { (field.value as? String) == name }) else {
            throw AdmissionError.refused("The exact NAME field did not read back OTA Runner before Save.")
        }
        try saveSettingsIfEnabled(in: app)
        try assertProfileName(in: app, name: name)
    }

    @MainActor
    private func seedWatchlist(in app: XCUIApplication, title: String) throws {
        try clickUniqueButton("Discover", in: app)
        capturePhase("discover-before-ranked-card", in: app)
        let rankedCard = try uniqueHittable(named(app.buttons, "#1: \(title)"), label: "#1: \(title)", timeout: 60)
        rankedCard.click()
        let detailQuery = named(app.groups, "\(title) details")
        XCTAssertTrue(detailQuery.firstMatch.waitForExistence(timeout: 30), "The exact title details dialog was not exposed.")
        XCTAssertEqual(detailQuery.count, 1, "The title details dialog was ambiguous.")
        let toggleRoles = [NSNumber(value: XCUIElement.ElementType.button.rawValue), NSNumber(value: XCUIElement.ElementType.checkBox.rawValue)]
        let detailActions = detailQuery.firstMatch.descendants(matching: .any).matching(NSPredicate(format: "elementType IN %@", toggleRoles))
        let detailButton = try uniqueHittable(named(detailActions, "Watchlist"), label: "Detail Watchlist", timeout: 30)
        detailButton.click()
        let selected = try uniqueHittable(named(detailActions, "In watchlist"), label: "In watchlist", timeout: 30)
        let selectedValue = (selected.value as? String)?.lowercased()
        XCTAssertTrue(selectedValue == "1" || selectedValue == "true" || (selected.value as? NSNumber)?.boolValue == true || selected.isSelected, "The exact Detail watchlist toggle was not selected.")
        let back = try uniqueHittable(named(detailQuery.firstMatch.buttons, "Back"), label: "Detail Back", timeout: 30)
        back.click()
        XCTAssertTrue(waitUntil(timeout: 30) { !detailQuery.firstMatch.exists }, "The Detail dialog did not close through its visible Back control.")
        try assertWatchlist(in: app, title: title)
    }

    @MainActor
    private func assertProfileName(in app: XCUIApplication, name: String) throws {
        try clickUniqueButton("Settings", in: app)
        try selectSettingsCategory("Profiles", in: app)
        _ = try uniqueHittable(app.textFields.matching(NSPredicate(format: "value == %@", name)), label: "seeded profile name", timeout: 30)
    }

    @MainActor
    private func assertCompactDensity(in app: XCUIApplication) throws {
        try clickUniqueButton("Settings", in: app)
        try selectSettingsCategory("Appearance", in: app)
        let styles = try uniqueExisting(named(app.groups, "Appearance styles"), label: "Appearance styles group", timeout: 30)
        let compact = try uniqueHittable(named(styles.checkBoxes, "Apply Compact control style"), label: "Apply Compact control style", timeout: 30)
        let stringValue = (compact.value as? String)?.lowercased()
        let pressed = stringValue == "1" || stringValue == "true" || (compact.value as? NSNumber)?.boolValue == true || compact.isSelected
        XCTAssertTrue(pressed, "Compact density was not selected after the lifecycle transition.")
    }

    @MainActor
    private func assertWatchlist(in app: XCUIApplication, title: String) throws {
        try clickUniqueButton("Watchlist", in: app)
        _ = try uniqueHittable(named(app.buttons, title), label: "watchlist title \(title)", timeout: 60)
    }

    @MainActor
    private func clickUniqueButton(_ label: String, in app: XCUIApplication) throws {
        let button = try uniqueHittable(named(app.buttons, label), label: label, timeout: 30)
        button.click()
    }

    @MainActor
    private func saveSettingsIfEnabled(in app: XCUIApplication) throws {
        let save = named(app.buttons, "Save changes").firstMatch
        if save.waitForExistence(timeout: 5), save.isEnabled {
            let button = try uniqueHittable(named(app.buttons, "Save changes"), label: "Save changes", timeout: 15)
            button.click()
            XCTAssertTrue(waitUntil(timeout: 30) {
                named(app.buttons, "Saved").firstMatch.exists || named(app.buttons, "Up to date").firstMatch.exists
            }, "The visible settings save did not reach its durable completion state.")
        }
    }

    @MainActor
    private func named(_ query: XCUIElementQuery, _ name: String) -> XCUIElementQuery {
        query.matching(NSPredicate(format: "title == %@ OR label == %@", name, name))
    }

    @MainActor
    private func findUniqueStaticText(_ query: XCUIElementQuery, text: String, timeout: TimeInterval) throws -> XCUIElement? {
        let deadline = Date().addingTimeInterval(timeout)
        repeat {
            // A WebKit heading can expose its title and a child text value.
            // Prefer the exact title instead of counting that pair twice.
            for attribute in ["title", "label", "value"] {
                let matches = query.matching(NSPredicate(format: "%K == %@", attribute, text))
                let count = matches.count
                guard count <= 1 else {
                    throw AdmissionError.refused("Ambiguous static text through \(attribute): \(text)")
                }
                if count == 1, matches.firstMatch.exists { return matches.firstMatch }
            }
            RunLoop.current.run(until: Date().addingTimeInterval(0.25))
        } while Date() < deadline
        return nil
    }

    @MainActor
    private func uniqueStaticText(_ query: XCUIElementQuery, text: String, timeout: TimeInterval) throws -> XCUIElement {
        guard let element = try findUniqueStaticText(query, text: text, timeout: timeout) else {
            throw AdmissionError.refused("Required unique static text was unavailable: \(text)")
        }
        return element
    }

    // HOST_UPDATE_NOTICE_BEGIN
    private struct NoticeNode {
        let role: String
        let title: String
        let label: String
        let value: String?
        let frame: CGRect
        let children: [NoticeNode]
    }
    private struct UpdateNoticeWitness {
        let frame: CGRect
        let installFrame: CGRect
        let dismissFrame: CGRect
        let windowFrame: CGRect
    }
    private enum NoticeWitnessError: Error { case bounds, ambiguousWindow, ambiguousNotice }
    private static func usableNoticeFrame(_ frame: CGRect) -> Bool {
        !frame.isNull && !frame.isInfinite && frame.origin.x.isFinite && frame.origin.y.isFinite && frame.width.isFinite && frame.height.isFinite && frame.width > 0 && frame.height > 0
    }
    private static func updateNoticeWitness(_ root: NoticeNode, expectedVersion: String) throws -> UpdateNoticeWitness? {
        var visited = 0
        var windows: [NoticeNode] = []
        func collectWindows(_ node: NoticeNode, depth: Int) throws {
            guard depth <= 32, visited < 1024 else { throw NoticeWitnessError.bounds }
            visited += 1
            if node.role == "window" { windows.append(node) }
            for child in node.children { try collectWindows(child, depth: depth + 1) }
        }
        try collectWindows(root, depth: 0)
        guard windows.count <= 1 else { throw NoticeWitnessError.ambiguousWindow }
        guard let window = windows.first, usableNoticeFrame(window.frame) else { return nil }
        var matches: [UpdateNoticeWitness] = []
        func exact(_ node: NoticeNode, _ text: String) -> Bool { node.title == text || node.label == text || node.value == text }
        func visit(_ node: NoticeNode) {
            if node.role == "group", usableNoticeFrame(node.frame), window.frame.contains(node.frame) {
                let parts = ["Update v", expectedVersion, " available"]
                let textIndices = parts.map { part in node.children.indices.filter { node.children[$0].role == "staticText" && exact(node.children[$0], part) } }
                let installIndices = node.children.indices.filter { node.children[$0].role == "button" && exact(node.children[$0], "Install") }
                let dismissIndices = node.children.indices.filter { node.children[$0].role == "button" && exact(node.children[$0], "Dismiss update notification") }
                if textIndices.allSatisfy({ $0.count == 1 }), Set(textIndices.flatMap { $0 }).count == 3,
                   installIndices.count == 1, dismissIndices.count == 1, installIndices[0] != dismissIndices[0] {
                    let install = node.children[installIndices[0]], dismiss = node.children[dismissIndices[0]]
                    if usableNoticeFrame(install.frame), usableNoticeFrame(dismiss.frame), node.frame.contains(install.frame), node.frame.contains(dismiss.frame), window.frame.contains(install.frame), window.frame.contains(dismiss.frame) {
                        matches.append(UpdateNoticeWitness(frame: node.frame, installFrame: install.frame, dismissFrame: dismiss.frame, windowFrame: window.frame))
                    }
                }
            }
            for child in node.children { visit(child) }
        }
        visit(window)
        guard matches.count <= 1 else { throw NoticeWitnessError.ambiguousNotice }
        return matches.first
    }
    // HOST_UPDATE_NOTICE_END

    @MainActor
    private func findUpdateOffer(in app: XCUIApplication, expectedVersion: String, timeout: TimeInterval) throws -> UpdateNoticeWitness? {
        let deadline = Date().addingTimeInterval(timeout)
        repeat {
            if let snapshot = try? app.snapshot() {
                var visited = 0
                func copy(_ element: any XCUIElementSnapshot, depth: Int) throws -> NoticeNode {
                    guard depth <= 32, visited < 1024 else { throw NoticeWitnessError.bounds }
                    visited += 1
                    let role: String
                    switch element.elementType { case .window: role = "window"; case .group: role = "group"; case .staticText: role = "staticText"; case .button: role = "button"; default: role = "other" }
                    let children = try element.children.map { try copy($0, depth: depth + 1) }
                    return NoticeNode(role: role, title: String(element.title.prefix(512)), label: String(element.label.prefix(512)), value: (element.value as? String).map { String($0.prefix(512)) }, frame: element.frame, children: children)
                }
                do {
                    let root = try copy(snapshot, depth: 0)
                    if Date() > deadline { return nil }
                    if let witness = try Self.updateNoticeWitness(root, expectedVersion: expectedVersion) { return witness }
                } catch {
                    capturePhase("update-offer-query-refused", in: app)
                    throw error
                }
            }
            RunLoop.current.run(until: Date().addingTimeInterval(0.25))
        } while Date() < deadline
        return nil
    }

    @MainActor
    private func textPrefixExists(_ query: XCUIElementQuery, prefix: String) -> Bool {
        let namedMatches = query.matching(NSPredicate(format: "title BEGINSWITH %@ OR label BEGINSWITH %@", prefix, prefix))
        if namedMatches.firstMatch.exists { return true }
        return query.allElementsBoundByIndex.prefix(128).contains {
            ($0.value as? String)?.hasPrefix(prefix) == true
        }
    }

    @MainActor
    private func captureInitialPublicAttributes(in app: XCUIApplication) {
        let welcome = named(app.groups, "Welcome").firstMatch
        guard welcome.waitForExistence(timeout: 30) else { return }
        // Read one immutable hierarchy, not live index references that can
        // disappear between property reads while WebKit finishes loading.
        guard let snapshot = try? welcome.snapshot() else { return }
        var buttons: [[String: String]] = []
        var texts: [[String: String]] = []
        var visited = 0
        func visit(_ element: any XCUIElementSnapshot, depth: Int) {
            guard depth <= 32, visited < 512 else { return }
            visited += 1
            let row = ["title": String(element.title.prefix(512)),
                       "label": String(element.label.prefix(512)),
                       "value": String(String(describing: element.value ?? "").prefix(512))]
            if element.elementType == .button, buttons.count < 20 { buttons.append(row) }
            if element.elementType == .staticText, texts.count < 20 { texts.append(row) }
            for child in element.children {
                visit(child, depth: depth + 1)
            }
        }
        visit(snapshot, depth: 0)
        let report = ["buttons": buttons, "staticTexts": texts]
        guard let data = try? JSONSerialization.data(withJSONObject: report, options: [.sortedKeys]), data.count <= 64_000 else {
            XCTFail("Initial public attribute diagnostics exceeded their bound.")
            return
        }
        let attachment = XCTAttachment(data: data, uniformTypeIdentifier: "public.json")
        attachment.name = "MacOTARuntime-initial-public-attributes"
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    @MainActor
    private func uniqueHittable(_ query: XCUIElementQuery, label: String, timeout: TimeInterval) throws -> XCUIElement {
        let element = query.firstMatch
        guard element.waitForExistence(timeout: timeout), query.count == 1, waitUntil(timeout: timeout, condition: { element.isHittable }) else {
            throw AdmissionError.refused("Required unique hittable control was unavailable: \(label)")
        }
        return element
    }

    @MainActor
    private func uniqueExisting(_ query: XCUIElementQuery, label: String, timeout: TimeInterval) throws -> XCUIElement {
        let element = query.firstMatch
        guard element.waitForExistence(timeout: timeout), query.count == 1 else {
            throw AdmissionError.refused("Required unique element was unavailable: \(label)")
        }
        return element
    }

    @MainActor
    private func capturePhase(_ name: String, in app: XCUIApplication) {
        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = "MacOTARuntime-\(name)-screenshot"
        screenshot.lifetime = .keepAlways
        add(screenshot)

        let boundedHierarchy = String(app.debugDescription.prefix(64_000))
        let hierarchy = XCTAttachment(data: Data(boundedHierarchy.utf8), uniformTypeIdentifier: "public.plain-text")
        hierarchy.name = "MacOTARuntime-\(name)-AX"
        hierarchy.lifetime = .keepAlways
        add(hierarchy)
    }

    private func loadConfiguration() throws -> Configuration {
        let root = "/Users/runner/work/_temp/mac-ota102"
        let expectedConfigPath = "\(root)/test-config.json"
        let expectedAppPath = "\(root)/private-app/YAWF Stream.app"
        let configuredPath = try XCTUnwrap(ProcessInfo.processInfo.environment["YAWF_OTA_CONFIG_PATH"])
        guard configuredPath == expectedConfigPath else {
            throw AdmissionError.refused("The test configuration must use the fixed private run root.")
        }
        let configuredURL = URL(fileURLWithPath: configuredPath).standardizedFileURL
        guard configuredURL == configuredURL.resolvingSymlinksInPath().standardizedFileURL else {
            throw AdmissionError.refused("The test configuration path or an ancestor is a symlink.")
        }
        let configuration = try JSONDecoder().decode(Configuration.self, from: Data(contentsOf: configuredURL))
        guard configuration.appPath == expectedAppPath,
              configuration.expectedBeforeVersion == "2.3.96",
              configuration.expectedAfterVersion == "2.3.102" else {
            throw AdmissionError.refused("The lifecycle configuration does not match the fixed public OTA scenario.")
        }
        return configuration
    }

    private func bundleVersion(_ url: URL) throws -> String {
        let bundle = try XCTUnwrap(Bundle(url: url))
        return try XCTUnwrap(bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String)
    }

    @MainActor
    private func uniqueRunningApplication(at url: URL) throws -> NSRunningApplication {
        let matches = NSWorkspace.shared.runningApplications.filter { $0.bundleURL?.standardizedFileURL == url }
        XCTAssertEqual(matches.count, 1, "Expected exactly one process from the admitted private bundle path.")
        return try XCTUnwrap(matches.first)
    }

    @MainActor
    private func waitForReplacementApplication(at url: URL, excluding pid: Int32, timeout: TimeInterval) throws -> NSRunningApplication {
        var match: NSRunningApplication?
        XCTAssertTrue(waitUntil(timeout: timeout) {
            let matches = NSWorkspace.shared.runningApplications.filter {
                $0.bundleURL?.standardizedFileURL == url && $0.processIdentifier != pid && !$0.isTerminated
            }
            if matches.count == 1 { match = matches[0]; return true }
            return false
        })
        return try XCTUnwrap(match)
    }

    @MainActor
    private func waitUntil(timeout: TimeInterval, condition: () -> Bool) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        repeat {
            if condition() { return true }
            RunLoop.current.run(until: Date().addingTimeInterval(0.25))
        } while Date() < deadline
        return condition()
    }

    @MainActor
    private func attachReceipt(_ receipt: Receipt) throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let attachment = XCTAttachment(data: try encoder.encode(receipt), uniformTypeIdentifier: "public.json")
        attachment.name = "MacOTARuntimeReceipt"
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}

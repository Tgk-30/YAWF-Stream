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

        try completeQuickSetup(in: activeApp)
        try seedCompactDensity(in: activeApp)
        try seedProfileName(in: activeApp, name: "OTA Runner")
        try seedWatchlist(in: activeApp, title: "Inception")

        var preInstallReopenUsed = false
        if !activeApp.staticTexts["Update v\(config.expectedAfterVersion) available"].waitForExistence(timeout: 180) {
            preInstallReopenUsed = true
            activeApp.typeKey("q", modifierFlags: .command)
            XCTAssertTrue(activeApp.wait(for: .notRunning, timeout: 30), "The baseline app did not stop through its normal Quit command before retrying its launch check.")
            XCTAssertEqual(try bundleVersion(appURL), config.expectedBeforeVersion)
            activeApp = XCUIApplication(url: appURL)
            activeApp.launch()
            XCTAssertTrue(activeApp.wait(for: .runningForeground, timeout: 30))
            installOwner = try uniqueRunningApplication(at: appURL)
        }
        let updateText = activeApp.staticTexts["Update v\(config.expectedAfterVersion) available"]
        XCTAssertTrue(updateText.waitForExistence(timeout: 180), "The public signed update was not offered after at most one normal relaunch check.")
        let beforeExecutablePath = try XCTUnwrap(installOwner.executableURL).path
        let install = try uniqueHittable(activeApp.buttons.matching(NSPredicate(format: "label == %@", "Install")), label: "Install", timeout: 15)
        install.click()
        XCTAssertTrue(waitUntil(timeout: 600) {
            installOwner.isTerminated || activeApp.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Installing")).firstMatch.exists
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
    private func completeQuickSetup(in app: XCUIApplication) throws {
        let quickSetup = try uniqueHittable(app.buttons.matching(NSPredicate(format: "label == %@", "Quick setup")), label: "Quick setup", timeout: 60)
        quickSetup.click()

        let heading = app.staticTexts["Continue without adding credentials"]
        XCTAssertTrue(heading.waitForExistence(timeout: 30))
        let acknowledgement = try uniqueHittable(
            app.checkBoxes.matching(NSPredicate(format: "label CONTAINS %@", "I understand the privacy, reliability, catalog, and playback limits")),
            label: "Quick setup acknowledgement",
            timeout: 15
        )
        if (acknowledgement.value as? String) != "1" { acknowledgement.click() }

        let continueButton = try uniqueHittable(app.buttons.matching(NSPredicate(format: "label == %@", "Continue with Quick setup")), label: "Continue with Quick setup", timeout: 15)
        continueButton.click()
        XCTAssertTrue(app.buttons["Discover"].waitForExistence(timeout: 60))
        let welcome = app.dialogs.matching(NSPredicate(format: "label == %@", "Welcome tour"))
        XCTAssertTrue(welcome.firstMatch.waitForExistence(timeout: 30), "The normal post-setup Welcome tour was not presented.")
        XCTAssertEqual(welcome.count, 1, "The Welcome tour dialog was ambiguous.")
        let skip = try uniqueHittable(welcome.firstMatch.buttons.matching(NSPredicate(format: "label == %@", "Skip the tour")), label: "Skip the tour", timeout: 15)
        skip.click()
        XCTAssertTrue(waitUntil(timeout: 15) { !welcome.firstMatch.exists }, "The Welcome tour did not close through its visible control.")
    }

    @MainActor
    private func seedCompactDensity(in app: XCUIApplication) throws {
        try clickUniqueButton("Settings", in: app)
        try clickUniqueButton("Appearance", in: app)
        let compact = try uniqueHittable(app.buttons.matching(NSPredicate(format: "label == %@", "Apply Compact control style")), label: "Apply Compact control style", timeout: 30)
        compact.click()
        try saveSettingsIfEnabled(in: app)
        try assertCompactDensity(in: app)
    }

    @MainActor
    private func seedProfileName(in app: XCUIApplication, name: String) throws {
        try clickUniqueButton("Settings", in: app)
        try clickUniqueButton("Profiles", in: app)
        let field = try uniqueHittable(app.textFields.matching(NSPredicate(format: "value == %@", "You")), label: "fresh Quick setup profile name", timeout: 30)
        field.click()
        field.typeKey("a", modifierFlags: .command)
        field.typeText(name)
        try saveSettingsIfEnabled(in: app)
        try assertProfileName(in: app, name: name)
    }

    @MainActor
    private func seedWatchlist(in app: XCUIApplication, title: String) throws {
        try clickUniqueButton("Discover", in: app)
        let rankedCard = try uniqueHittable(app.buttons.matching(NSPredicate(format: "label == %@", "#1: \(title)")), label: "#1: \(title)", timeout: 60)
        rankedCard.click()
        let detailQuery = app.dialogs.matching(NSPredicate(format: "label == %@", "\(title) details"))
        XCTAssertTrue(detailQuery.firstMatch.waitForExistence(timeout: 30), "The exact title details dialog was not exposed.")
        XCTAssertEqual(detailQuery.count, 1, "The title details dialog was ambiguous.")
        let detailButton = try uniqueHittable(detailQuery.firstMatch.buttons.matching(NSPredicate(format: "label == %@", "Watchlist")), label: "Detail Watchlist", timeout: 30)
        detailButton.click()
        _ = try uniqueHittable(detailQuery.firstMatch.buttons.matching(NSPredicate(format: "label == %@", "In watchlist")), label: "In watchlist", timeout: 30)
        let back = try uniqueHittable(detailQuery.firstMatch.buttons.matching(NSPredicate(format: "label == %@", "Back")), label: "Detail Back", timeout: 30)
        back.click()
        XCTAssertTrue(waitUntil(timeout: 30) { !detailQuery.firstMatch.exists }, "The Detail dialog did not close through its visible Back control.")
        try assertWatchlist(in: app, title: title)
    }

    @MainActor
    private func assertProfileName(in app: XCUIApplication, name: String) throws {
        try clickUniqueButton("Settings", in: app)
        try clickUniqueButton("Profiles", in: app)
        _ = try uniqueHittable(app.textFields.matching(NSPredicate(format: "value == %@", name)), label: "seeded profile name", timeout: 30)
    }

    @MainActor
    private func assertCompactDensity(in app: XCUIApplication) throws {
        try clickUniqueButton("Settings", in: app)
        try clickUniqueButton("Appearance", in: app)
        let compact = try uniqueHittable(app.buttons.matching(NSPredicate(format: "label == %@", "Apply Compact control style")), label: "Apply Compact control style", timeout: 30)
        let stringValue = (compact.value as? String)?.lowercased()
        let pressed = stringValue == "1" || stringValue == "true" || (compact.value as? NSNumber)?.boolValue == true || compact.isSelected
        XCTAssertTrue(pressed, "Compact density was not selected after the lifecycle transition.")
    }

    @MainActor
    private func assertWatchlist(in app: XCUIApplication, title: String) throws {
        try clickUniqueButton("Watchlist", in: app)
        _ = try uniqueHittable(app.buttons.matching(NSPredicate(format: "label == %@", title)), label: "watchlist title \(title)", timeout: 60)
    }

    @MainActor
    private func clickUniqueButton(_ label: String, in app: XCUIApplication) throws {
        let button = try uniqueHittable(app.buttons.matching(NSPredicate(format: "label == %@", label)), label: label, timeout: 30)
        button.click()
    }

    @MainActor
    private func saveSettingsIfEnabled(in app: XCUIApplication) throws {
        let save = app.buttons["Save changes"]
        if save.waitForExistence(timeout: 5), save.isEnabled {
            let button = try uniqueHittable(app.buttons.matching(NSPredicate(format: "label == %@", "Save changes")), label: "Save changes", timeout: 15)
            button.click()
            XCTAssertTrue(waitUntil(timeout: 30) {
                app.buttons["Saved"].exists || app.buttons["Up to date"].exists
            }, "The visible settings save did not reach its durable completion state.")
        }
    }

    @MainActor
    private func uniqueHittable(_ query: XCUIElementQuery, label: String, timeout: TimeInterval) throws -> XCUIElement {
        let element = query.firstMatch
        guard element.waitForExistence(timeout: timeout), query.count == 1, waitUntil(timeout: timeout, condition: { element.isHittable }) else {
            throw AdmissionError.refused("Required unique hittable control was unavailable: \(label)")
        }
        return element
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

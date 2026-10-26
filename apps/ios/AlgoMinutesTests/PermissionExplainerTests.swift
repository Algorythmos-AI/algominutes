import UserNotifications
import XCTest
@testable import AlgoMinutes

/// The microphone and notification permissions (RELEASE.md PR 10a): said
/// before iOS asks, and a way back through Settings after a refusal.
final class PermissionExplainerTests: XCTestCase {
    func testStartRecordingRoutesByTheMicrophonePermission() {
        XCTAssertEqual(MicPermission.route(for: .granted), .record)
        XCTAssertEqual(MicPermission.route(for: .undetermined), .ask)
        XCTAssertEqual(MicPermission.route(for: .denied), .openSettings)
    }

    func testARefusalLeadsToThisAppsSettings() {
        XCTAssertNotNil(MicPermission.settingsURL)
        XCTAssertTrue(MicPermission.deniedMessage.contains("Settings"))
        XCTAssertTrue(MicPermission.explainer.contains("Allow"))
        // The recorder's own error, for a refusal after the sheet, says the same.
        XCTAssertTrue(RecorderService.RecorderError.permissionDenied.errorDescription?.contains("Settings") == true)
    }

    @MainActor
    func testNotificationsAreExplainedOnlyBeforeIOSHasAskedAndOncePerLaunch() {
        XCTAssertTrue(RecordingNotifier.shouldPrePrompt(status: .notDetermined, askedThisLaunch: false))
        XCTAssertFalse(RecordingNotifier.shouldPrePrompt(status: .notDetermined, askedThisLaunch: true))
        for status: UNAuthorizationStatus in [.authorized, .denied, .provisional, .ephemeral] {
            XCTAssertFalse(RecordingNotifier.shouldPrePrompt(status: status, askedThisLaunch: false), "\(status.rawValue)")
        }
        XCTAssertTrue(RecordingNotifier.prePromptMessage.contains("iOS asks next"))
    }
}

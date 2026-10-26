import XCTest
@testable import AlgoMinutes

// MARK: - Consent for another app's audio covers one capture (RELEASE.md rev 11, H11/L9)

final class AppAudioConsentTests: XCTestCase {
    @MainActor
    func testTheMicrophonesConsentDoesNotCoverAppAudio() async {
        let gate = SessionConsentGate()
        gate.acknowledge()
        let mic = await gate.satisfied(for: .microphone)
        let appAudio = await gate.satisfied(for: .appAudio)
        XCTAssertTrue(mic)
        XCTAssertFalse(appAudio, "a Control Center capture after a mic recording must ask")
    }

    @MainActor
    func testAnAppAudioConsentCoversOneCapture() async {
        let gate = SessionConsentGate()
        gate.acknowledge(for: .appAudio)
        let first = await gate.satisfied(for: .appAudio)
        XCTAssertTrue(first)
        gate.consume(.appAudio)
        let second = await gate.satisfied(for: .appAudio)
        XCTAssertFalse(second, "the next capture asks again")
        let mic = await gate.satisfied(for: .microphone)
        XCTAssertFalse(mic, "an app-audio consent isn't the microphone's")
    }

    @MainActor
    func testSignOutClearsBoth() async {
        let gate = SessionConsentGate()
        gate.acknowledge()
        gate.acknowledge(for: .appAudio)
        gate.reset()
        let mic = await gate.satisfied(for: .microphone)
        let appAudio = await gate.satisfied(for: .appAudio)
        XCTAssertFalse(mic)
        XCTAssertFalse(appAudio)
    }
}

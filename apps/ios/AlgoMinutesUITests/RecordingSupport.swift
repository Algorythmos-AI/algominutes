import XCTest

/// The steps the recording tests share: record from Home, wait for the note, delete it. They make real notes on
/// staging, so they run only when asked (device-tests.sh --recording) and delete what they made.
extension XCTestCase {
    /// Skips unless the run opted in: device-tests.sh sets TEST_RUNNER_<name>=1, which the tests see as <name>.
    func requireOptIn(_ name: String, _ flag: String) throws {
        guard ProcessInfo.processInfo.environment[name] == "1" else {
            throw XCTSkip("opt-in: run device-tests.sh with \(flag)")
        }
    }

    /// The ids of the notes in Home's Recent list.
    @MainActor
    func recentNoteIds(_ app: XCUIApplication) -> Set<String> {
        let rows = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'home.recent.'"))
        return Set(rows.allElementsBoundByIndex.map { String($0.identifier.dropFirst("home.recent.".count)) })
    }

    /// From Home: the consent sheet, Start, then the recording screen with its timer running.
    @MainActor
    func startRecording(_ app: XCUIApplication, file: StaticString = #filePath, line: UInt = #line) throws {
        app.openTab("Home")
        let record = app.element("home.action.recording")
        XCTAssertTrue(record.waitForExistence(timeout: 10), "no Instant Recorder on Home", file: file, line: line)
        record.tap()

        let start = app.buttons["recorder.consent.start"]
        guard start.waitForExistence(timeout: 10) else {
            screenshot(app, "no consent sheet")
            XCTFail("the consent sheet didn't open (no minutes left? the paywall or invite sheet came up)", file: file, line: line)
            throw XCTSkip("can't record")
        }
        XCTAssertFalse(start.isEnabled, "Start is enabled before the permission is ticked", file: file, line: line)
        app.element("recorder.consent.acknowledge").tap()
        XCTAssertTrue(start.isEnabled, "ticking the permission didn't enable Start", file: file, line: line)
        start.tap()
        // iOS asks for the microphone only the first time.
        let allow = XCUIApplication(bundleIdentifier: "com.apple.springboard").alerts.buttons["Allow"]
        if allow.waitForExistence(timeout: 3) { allow.tap() }

        XCTAssertTrue(app.element("recording.timer").waitForExistence(timeout: 15), "the recording screen didn't open",
                      file: file, line: line)
    }

    /// Seconds on the recording screen's timer ("01:05" is 65), or nil when it can't be read.
    @MainActor
    func recordedSeconds(_ app: XCUIApplication) -> Int? {
        guard let value = app.element("recording.timer").value as? String else { return nil }
        let parts = value.split(separator: ":").compactMap { Int($0) }
        return parts.count == 2 ? parts[0] * 60 + parts[1] : nil
    }

    /// Waits until the timer reads at least `seconds`.
    @MainActor
    func waitUntilRecorded(_ app: XCUIApplication, seconds: Int, file: StaticString = #filePath, line: UInt = #line) {
        let reached = XCTNSPredicateExpectation(
            predicate: NSPredicate { _, _ in (self.recordedSeconds(app) ?? 0) >= seconds }, object: nil
        )
        XCTAssertEqual(XCTWaiter().wait(for: [reached], timeout: TimeInterval(seconds + 20)), .completed,
                       "the timer never reached \(seconds) s (it reads \(recordedSeconds(app).map(String.init) ?? "nothing"))",
                       file: file, line: line)
    }

    /// The app's own alerts that can come up over a recording (the notifications pre-prompt): answered "Not now".
    @MainActor
    func dismissAppAlerts(_ app: XCUIApplication) {
        let alert = app.alerts.firstMatch
        if alert.exists, alert.buttons["Not now"].exists { alert.buttons["Not now"].tap() }
    }

    /// End, then back to Home; the new note's id, as the Recent row that wasn't there before.
    @MainActor
    func endRecording(_ app: XCUIApplication, before: Set<String>, file: StaticString = #filePath, line: UInt = #line) throws -> String {
        dismissAppAlerts(app)
        app.element("recording.end").tap()
        // Ending opens the new note.
        XCTAssertTrue(app.buttons["note.more"].waitForExistence(timeout: 60), "ending didn't open a note", file: file, line: line)
        goBack(app)

        var made: Set<String> = []
        let appeared = XCTNSPredicateExpectation(
            predicate: NSPredicate { _, _ in
                made = self.recentNoteIds(app).subtracting(before)
                return made.count == 1
            }, object: nil
        )
        _ = XCTWaiter().wait(for: [appeared], timeout: 60)
        return try XCTUnwrap(made.first, "no new note in Recent (new rows: \(made.count))", file: file, line: line)
    }

    /// Waits for the note to be done with: Ready, Couldn't process, or Waiting for minutes. Its status, as Home says it.
    @MainActor
    func waitUntilProcessed(_ app: XCUIApplication, noteId: String, timeout: TimeInterval) -> String {
        let row = app.element("home.recent.\(noteId)")
        let finished = ["Ready", "Couldn’t process", "Waiting for minutes"]
        let done = XCTNSPredicateExpectation(
            predicate: NSPredicate { _, _ in finished.contains { row.exists && row.label.hasSuffix(". \($0)") } }, object: nil
        )
        _ = XCTWaiter().wait(for: [done], timeout: timeout)
        guard row.exists else { return "gone" }
        return finished.first { row.label.hasSuffix(". \($0)") } ?? "still processing: \(row.label.split(separator: ".").last ?? "")"
    }

    /// Opens the note from Recent and deletes it (More operations, Delete, then Delete in the confirmation).
    @MainActor
    func deleteNote(_ app: XCUIApplication, noteId: String, file: StaticString = #filePath, line: UInt = #line) {
        app.openTab("Home")
        let row = app.element("home.recent.\(noteId)")
        guard row.waitForExistence(timeout: 10) else {
            XCTFail("note \(noteId) isn't in Recent to delete", file: file, line: line)
            return
        }
        row.tap()
        let more = app.buttons["note.more"]
        XCTAssertTrue(more.waitForExistence(timeout: 10), "the note didn't open", file: file, line: line)
        more.tap()
        let delete = app.element("note.delete")
        XCTAssertTrue(delete.waitForExistence(timeout: 5), "no Delete in More operations", file: file, line: line)
        delete.tap()
        XCTAssertTrue(app.staticTexts["Delete this note?"].waitForExistence(timeout: 5), "deleting didn't ask first",
                      file: file, line: line)
        app.buttons["Delete"].firstMatch.tap()
        // Deleting closes the note; if it didn't, go back.
        if !app.buttons["note.more"].waitForNonExistence(timeout: 5) { goBack(app) }
        XCTAssertTrue(row.waitForNonExistence(timeout: 30), "the deleted note is still in Recent", file: file, line: line)
    }

    /// The navigation bar's Back: its leftmost button (the note's own buttons are on the right).
    @MainActor
    func goBack(_ app: XCUIApplication) {
        let buttons = app.navigationBars.buttons.allElementsBoundByIndex.filter(\.isHittable)
        buttons.min { $0.frame.minX < $1.frame.minX }?.tap()
    }
}

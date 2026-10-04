import XCTest
@testable import AlgoMinutes

// MARK: - Search finds transcript words as you type (RELEASE.md rev 11, UX8)
//
// Transcripts were searched only on Return, and the list said "No files match"
// the moment the titles ran out, before it had looked in a single transcript.

final class FilesSearchTests: XCTestCase {
    func testAQueryIsSearchedFromThreeCharactersTrimmed() {
        XCTAssertNil(FilesView.searchable(""))
        XCTAssertNil(FilesView.searchable("ab"))
        XCTAssertNil(FilesView.searchable("  ab  "))
        XCTAssertEqual(FilesView.searchable("abc"), "abc")
        XCTAssertEqual(FilesView.searchable("  budget  "), "budget")
    }

    func testNothingIsSaidBeforeTheTranscriptsHaveBeenSearchedForWhatIsTyped() {
        // Typed, not yet searched: say nothing.
        XCTAssertNil(FilesView.emptyMessage(query: "budget", isSearching: false, searchedQuery: nil))
        // The hits on screen are for an earlier query.
        XCTAssertNil(FilesView.emptyMessage(query: "budget", isSearching: false, searchedQuery: "bud"))
        // A search is running.
        XCTAssertNil(FilesView.emptyMessage(query: "budget", isSearching: true, searchedQuery: "budget"))
    }

    func testOnceSearchedItSaysNothingMatchedInFilesOrTranscripts() {
        XCTAssertEqual(
            FilesView.emptyMessage(query: " budget ", isSearching: false, searchedQuery: "budget"),
            "No files or transcripts match that search."
        )
    }

    func testAQueryTooShortToSearchOnlyEverMatchesTitles() {
        XCTAssertEqual(FilesView.emptyMessage(query: "ab", isSearching: false, searchedQuery: nil), "No files match that search.")
    }

    func testAnEmptyQueryIsTheEmptyLibrary() throws {
        let message = try XCTUnwrap(FilesView.emptyMessage(query: "", isSearching: false, searchedQuery: nil))
        XCTAssertTrue(message.hasPrefix("Nothing here yet"), message)
    }
}

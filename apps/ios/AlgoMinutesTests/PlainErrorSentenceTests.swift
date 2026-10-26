import XCTest
@testable import AlgoMinutes

// MARK: - Errors in plain words (RELEASE.md rev 11, UX7)
//
// An alert used to read "Request failed (500)", "Invalid server response", or
// the server's bare code ("rate_limited").

final class PlainErrorSentenceTests: XCTestCase {
    func testTheServersOwnSentenceIsKept() {
        let text = "A notetaker is already on its way to this meeting."
        XCTAssertEqual(APIError.sentence(status: 409, serverText: text), text)
        XCTAssertEqual(APIError.http(status: 409, message: text).errorDescription, text)
    }

    func testACodeOrNothingBecomesASentenceForTheStatus() {
        for code in [nil, "", "rate_limited", "Forbidden", "Not Found", "internal_error", "quota_exceeded"] as [String?] {
            for status in [400, 401, 403, 404, 408, 409, 413, 429, 500, 503, 504] {
                let said = APIError.sentence(status: status, serverText: code)
                XCTAssertTrue(APIError.isSentence(said), "\(status) \(code ?? "nil"): \(said)")
                XCTAssertFalse(said.contains("\(status)"), said)
                XCTAssertFalse(said.contains("_"), said)
            }
        }
    }

    func testEachStatusSaysWhatToDoAboutIt() {
        XCTAssertTrue(APIError.sentence(status: 429, serverText: "rate_limited").contains("wait a moment"))
        XCTAssertTrue(APIError.sentence(status: 401, serverText: nil).contains("sign in"))
        XCTAssertTrue(APIError.sentence(status: 503, serverText: nil).contains("our side"))
        XCTAssertTrue(APIError.sentence(status: 404, serverText: "Not Found").contains("couldn’t be found"))
    }

    func testNoErrorShowsAStatusNumberOrADevelopersPhrase() {
        for error in [APIError.notSignedIn, .invalidResponse, .http(status: 500, message: nil), .http(status: 418, message: "teapot")] {
            let said = error.errorDescription ?? ""
            XCTAssertTrue(APIError.isSentence(said), said)
            XCTAssertFalse(said.contains("Request failed"), said)
            XCTAssertFalse(said.contains("Invalid server response"), said)
            XCTAssertNil(said.range(of: "\\d{3}", options: .regularExpression), said)
        }
    }
}

import XCTest
@testable import AlgoMinutes

/// App Review buys Pro in the sandbox and taps Restore (guidelines 3.1.1 / 2.1). Whatever billing says about the
/// receipt, the person sees it: a rejected receipt is not a purchase that did nothing, and Restore always ends
/// with a sentence.
@MainActor
final class PurchaseOutcomeTests: XCTestCase {
    private struct Offline: Error {}

    /// Billing as the app reaches it: one canned answer, or one thrown error.
    private struct FakeBilling: PurchaseVerifying {
        let answer: Result<VerifyPurchaseResponse, Error>
        func verifyPurchase(jws: String) async throws -> VerifyPurchaseResponse { try answer.get() }
    }

    private func verdict(_ answer: Result<VerifyPurchaseResponse, Error>) async -> ReceiptVerdict {
        await ReceiptVerdict.check(jws: "jws", with: FakeBilling(answer: answer))
    }

    // MARK: - What billing said

    func testOkIsAccepted() async {
        let v = await verdict(.success(VerifyPurchaseResponse(ok: true, entitlementState: "active")))
        XCTAssertEqual(v, .accepted)
        XCTAssertEqual(v.purchaseOutcome, .success)
    }

    func testNotOkIsRejected() async {
        let v = await verdict(.success(VerifyPurchaseResponse(ok: false, entitlementState: "free_floor")))
        XCTAssertEqual(v, .rejected(.notVerified))
        guard case .failed(let message) = v.purchaseOutcome else { return XCTFail("a rejected receipt must say so") }
        XCTAssertTrue(message.contains("couldn’t verify"), message)
    }

    // services/billing/src/routes/verify.js: the receipt is already another uid's (a guest who bought, signed out,
    // and is now on another account).
    func testReceiptOnAnotherAccountIs409() async {
        let v = await verdict(.failure(APIError.http(status: 409, message: "Receipt already linked to another account")))
        XCTAssertEqual(v, .rejected(.linkedToAnotherAccount))
        XCTAssertEqual(
            v.purchaseOutcome,
            .failed("This subscription belongs to another AlgoMinutes account. Sign in with that account to use it.")
        )
    }

    func testRevokedReceiptIsItsOwn409() async {
        let v = await verdict(.failure(APIError.http(status: 409, message: "Receipt revoked")))
        XCTAssertEqual(v, .rejected(.revoked))
    }

    func testInvalidReceiptIsRejected() async {
        let v = await verdict(.failure(APIError.http(status: 400, message: "Invalid receipt")))
        XCTAssertEqual(v, .rejected(.notVerified))
    }

    func testNetworkErrorLeavesItToRetry() async {
        let v = await verdict(.failure(URLError(.notConnectedToInternet)))
        XCTAssertEqual(v, .unreachable)
        XCTAssertEqual(v.purchaseOutcome, .confirmationDelayed)
        XCTAssertEqual(
            StoreKitService.PurchaseOutcome.confirmationDelayedMessage,
            "We couldn’t confirm your purchase yet. It will finish automatically; you won’t be charged twice."
        )
    }

    func testServerTroubleLeavesItToRetry() async {
        for error: Error in [
            APIError.http(status: 503, message: nil),
            APIError.http(status: 429, message: "rate_limited"),
            APIError.http(status: 401, message: nil),
            APIError.notSignedIn,
            APIError.invalidResponse,
            Offline(),
        ] {
            let v = await verdict(.failure(error))
            XCTAssertEqual(v, .unreachable, "\(error)")
        }
    }

    // MARK: - Restore ends with a sentence

    func testRestoreWithNothingToRestore() {
        let outcome = RestoreOutcome.from([])
        XCTAssertEqual(outcome, .nothingFound)
        XCTAssertEqual(outcome.message, "No purchases found for this Apple Account.")
    }

    func testRestoreAccepted() {
        let outcome = RestoreOutcome.from([.accepted])
        XCTAssertEqual(outcome, .restored)
        XCTAssertEqual(outcome.message, "Pro restored.")
    }

    func testRestoreOntoAnotherAccount() {
        let outcome = RestoreOutcome.from([.rejected(.linkedToAnotherAccount)])
        XCTAssertEqual(outcome, .belongsToAnotherAccount)
        XCTAssertEqual(
            outcome.message,
            "This subscription belongs to another AlgoMinutes account. Sign in with that account to use it."
        )
    }

    func testRestoreUnreachable() {
        let outcome = RestoreOutcome.from([.unreachable])
        XCTAssertEqual(outcome, .notConfirmed)
        XCTAssertTrue(outcome.message.contains("couldn’t reach AlgoMinutes"), outcome.message)
    }

    func testRestoreRejected() {
        XCTAssertEqual(RestoreOutcome.from([.rejected(.revoked)]), .notRestored(.revoked))
        XCTAssertEqual(RestoreOutcome.from([.rejected(.notVerified)]), .notRestored(.notVerified))
    }

    /// One good receipt is Pro, whatever else came back; then the 409, then a retry, then any other refusal.
    func testRestoreMixedVerdicts() {
        XCTAssertEqual(RestoreOutcome.from([.unreachable, .rejected(.linkedToAnotherAccount), .accepted]), .restored)
        XCTAssertEqual(RestoreOutcome.from([.unreachable, .rejected(.linkedToAnotherAccount)]), .belongsToAnotherAccount)
        XCTAssertEqual(RestoreOutcome.from([.rejected(.revoked), .unreachable]), .notConfirmed)
    }

    func testEveryRestoreOutcomeSaysSomething() {
        let all: [RestoreOutcome] = [
            .restored, .nothingFound, .belongsToAnotherAccount, .notConfirmed,
            .notRestored(.revoked), .notRestored(.notVerified), .notRestored(.linkedToAnotherAccount),
        ]
        for outcome in all {
            XCTAssertFalse(outcome.message.isEmpty, "\(outcome)")
        }
    }
}

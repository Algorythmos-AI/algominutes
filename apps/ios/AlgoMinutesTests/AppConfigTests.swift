import XCTest
@testable import AlgoMinutes

/// The backend each build talks to comes from its build configuration
/// (project.yml → Info.plist → AppConfig), never a hardcoded origin.
final class AppConfigTests: XCTestCase {
    func testAcceptsAnHttpsOriginOnly() {
        XCTAssertEqual(
            AppConfig.validatedBaseURL("https://api-627101926311.australia-southeast1.run.app")?.host,
            "api-627101926311.australia-southeast1.run.app"
        )
        XCTAssertEqual(AppConfig.validatedBaseURL(" https://x.run.app/ ")?.host, "x.run.app")
        XCTAssertNil(AppConfig.validatedBaseURL("http://x.run.app"))
        XCTAssertNil(AppConfig.validatedBaseURL("https://x.run.app/v1"))
        XCTAssertNil(AppConfig.validatedBaseURL("https://x.run.app?a=1"))
        XCTAssertNil(AppConfig.validatedBaseURL("$(API_BASE_URL)"))
        XCTAssertNil(AppConfig.validatedBaseURL(""))
    }

    func testReadsTheInfoPlistValueAndFallsBackOnlyWhenItIsMissingOrInvalid() {
        XCTAssertEqual(AppConfig.baseURL(forKey: "k", info: ["k": "https://b.run.app"]).host, "b.run.app")
        XCTAssertEqual(AppConfig.baseURL(forKey: "k", info: ["k": "not a url"]), AppConfig.fallbackBaseURL)
        XCTAssertEqual(AppConfig.baseURL(forKey: "k", info: [:]), AppConfig.fallbackBaseURL)
        // The fallback never resolves (RFC 6761), so a misconfigured build can't
        // send ID tokens to a host someone else could own.
        XCTAssertTrue(AppConfig.fallbackBaseURL.host?.hasSuffix(".invalid") == true)
    }

    /// Tests run the Debug configuration, which talks to staging.
    func testTheDebugBuildTalksToStaging() {
        XCTAssertEqual(AppConfig.apiBaseURL.host, "api-627101926311.australia-southeast1.run.app")
        XCTAssertEqual(AppConfig.billingBaseURL.host, "billing-627101926311.australia-southeast1.run.app")
        XCTAssertEqual(APIClient.baseURL, AppConfig.apiBaseURL)
    }

    /// The update screen's button: the TestFlight app in every build for now,
    /// and no button for an unset or unexpanded value.
    func testUpdateURL() {
        XCTAssertEqual(AppConfig.updateURL?.scheme, "itms-beta")
        XCTAssertEqual(AppConfig.updateURL(info: ["AlgoMinutesUpdateURL": "itms-apps://apps.apple.com/app/id1"])?.scheme, "itms-apps")
        XCTAssertNil(AppConfig.updateURL(info: ["AlgoMinutesUpdateURL": "$(UPDATE_URL)"]))
        XCTAssertNil(AppConfig.updateURL(info: ["AlgoMinutesUpdateURL": ""]))
        XCTAssertNil(AppConfig.updateURL(info: ["AlgoMinutesUpdateURL": "http://example.com"]))
        XCTAssertNil(AppConfig.updateURL(info: [:]))
    }

    /// Debug keeps the paywall (for development); Staging and Release set NO until
    /// the products exist. Anything but YES is off.
    func testPaywallFlag() {
        XCTAssertTrue(AppConfig.paywallEnabled)
        XCTAssertTrue(AppConfig.paywallEnabled(info: ["AlgoMinutesPaywallEnabled": "yes"]))
        XCTAssertFalse(AppConfig.paywallEnabled(info: ["AlgoMinutesPaywallEnabled": "NO"]))
        XCTAssertFalse(AppConfig.paywallEnabled(info: ["AlgoMinutesPaywallEnabled": "$(PAYWALL_ENABLED)"]))
        XCTAssertFalse(AppConfig.paywallEnabled(info: [:]))
    }

    /// The old Firebase project's Google client (909388484461) is gone, and the
    /// app's own deep-link scheme is registered.
    func testURLSchemes() {
        let types = Bundle.main.object(forInfoDictionaryKey: "CFBundleURLTypes") as? [[String: Any]] ?? []
        let schemes = types.flatMap { $0["CFBundleURLSchemes"] as? [String] ?? [] }
        XCTAssertTrue(schemes.contains("algominutes"))
        XCTAssertFalse(schemes.contains { $0.contains("909388484461") })
    }

    /// Share links open on the public site, which has no viewer yet.
    func testShareLinksAreOffUntilTheSiteCanShowThem() {
        XCTAssertFalse(AppConfig.shareLinksEnabled)
        XCTAssertTrue(AppConfig.flag("k", info: ["k": " yes "]))
        XCTAssertFalse(AppConfig.flag("k", info: ["k": "NO"]))
        XCTAssertFalse(AppConfig.flag("k", info: ["k": "$(SHARE_LINKS_ENABLED)"]))
        XCTAssertFalse(AppConfig.flag("k", info: nil))
    }
}

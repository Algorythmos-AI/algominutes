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
    }

    /// Tests run the Debug configuration, which talks to staging.
    func testTheDebugBuildTalksToStaging() {
        XCTAssertEqual(AppConfig.apiBaseURL.host, "api-627101926311.australia-southeast1.run.app")
        XCTAssertEqual(AppConfig.billingBaseURL.host, "billing-627101926311.australia-southeast1.run.app")
        XCTAssertEqual(APIClient.baseURL, AppConfig.apiBaseURL)
    }

    /// The old Firebase project's Google client (909388484461) is gone, and the
    /// app's own deep-link scheme is registered.
    func testURLSchemes() {
        let types = Bundle.main.object(forInfoDictionaryKey: "CFBundleURLTypes") as? [[String: Any]] ?? []
        let schemes = types.flatMap { $0["CFBundleURLSchemes"] as? [String] ?? [] }
        XCTAssertTrue(schemes.contains("algominutes"))
        XCTAssertFalse(schemes.contains { $0.contains("909388484461") })
    }
}

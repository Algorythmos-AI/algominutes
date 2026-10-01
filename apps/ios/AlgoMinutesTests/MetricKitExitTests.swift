import XCTest
@testable import AlgoMinutes

// MARK: - MetricKit's abnormal exits (RELEASE.md rev 11, H15)

final class MetricKitExitTests: XCTestCase {
    func testOnlyNonZeroCausesAreReported() {
        var exits = MetricKitReporter.AbnormalExits()
        XCTAssertEqual(exits.reported, [:])
        exits.memoryLimit = 2
        exits.backgroundTimeout = 1
        XCTAssertEqual(exits.reported, ["memory_limit": 2, "background_task_timeout": 1])
    }
}

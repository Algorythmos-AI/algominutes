import XCTest
@testable import AlgoMinutes

/// PR-24: the rest of an upload goes as one background PUT, from the file itself
/// at byte 0, or from a copy of its tail when resuming.
final class UploadRemainderTests: XCTestCase {
    func testTheRemainderIsTheSessionsFinalRange() {
        XCTAssertEqual(BackgroundUploadService.contentRange(from: 0, total: 1_000), "bytes 0-999/1000")
        XCTAssertEqual(BackgroundUploadService.contentRange(from: 262_144, total: 1_000_000), "bytes 262144-999999/1000000")
    }

    func testTheTailCopyHoldsExactlyTheBytesFromTheOffset() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("tail-test-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        // Larger than one 4 MB copy slice, so the slicing is exercised.
        let bytes = Data((0..<(5 * 1024 * 1024 + 123)).map { UInt8($0 % 251) })
        let file = dir.appendingPathComponent("recording.aac")
        try bytes.write(to: file)

        let offset: Int64 = 1_048_576
        let tail = try BackgroundUploadService.writeTail(of: file, from: offset, uploadId: "u-test")
        defer { try? FileManager.default.removeItem(at: tail) }
        XCTAssertEqual(try Data(contentsOf: tail), bytes.subdata(in: Int(offset)..<bytes.count))
        XCTAssertTrue(tail.path.hasPrefix(BackgroundUploadService.tailDirectory().path))

        // A second copy at the same offset replaces the first rather than appending.
        let again = try BackgroundUploadService.writeTail(of: file, from: offset, uploadId: "u-test")
        XCTAssertEqual(try Data(contentsOf: again).count, bytes.count - Int(offset))
    }
}

import FirebaseCore
import FirebaseCrashlytics
import Foundation
import MetricKit

/// The failures Crashlytics never sees (RELEASE.md rev 11, H15): the system
/// ending the app for memory (jetsam), for a watchdog, or for background time
/// that ran out, and hangs. None of these is a crash the app can catch, so the
/// crash-free figure counted them as fine. MetricKit reports them the next day;
/// each becomes a Crashlytics non-fatal, with the payload's summary as a log
/// line. MetricKit carries no user content: counts, build, and call stacks.
final class MetricKitReporter: NSObject, MXMetricManagerSubscriber {
    static let shared = MetricKitReporter()

    /// Called once at launch, after Firebase is configured.
    func start() {
        MXMetricManager.shared.add(self)
    }

    // MARK: - Exits (MXMetricPayload, daily)

    /// A day's abnormal exits, by cause, in the foreground and the background.
    struct AbnormalExits: Equatable {
        var memoryLimit = 0
        var memoryPressure = 0
        var watchdog = 0
        var backgroundTimeout = 0
        var otherAbnormal = 0

        /// Non-zero counts, by name, for the non-fatal's user info.
        var reported: [String: Int] {
            [
                "memory_limit": memoryLimit,
                "memory_pressure": memoryPressure,
                "watchdog": watchdog,
                "background_task_timeout": backgroundTimeout,
                "other_abnormal": otherAbnormal,
            ].filter { $0.value > 0 }
        }
    }

    static func abnormalExits(_ metric: MXAppExitMetric) -> AbnormalExits {
        let fg = metric.foregroundExitData
        let bg = metric.backgroundExitData
        var exits = AbnormalExits()
        exits.memoryLimit = fg.cumulativeMemoryResourceLimitExitCount + bg.cumulativeMemoryResourceLimitExitCount
        exits.memoryPressure = bg.cumulativeMemoryPressureExitCount
        exits.watchdog = fg.cumulativeAppWatchdogExitCount + bg.cumulativeAppWatchdogExitCount
        exits.backgroundTimeout = bg.cumulativeBackgroundTaskAssertionTimeoutExitCount
        exits.otherAbnormal = fg.cumulativeAbnormalExitCount + bg.cumulativeAbnormalExitCount
        return exits
    }

    func didReceive(_ payloads: [MXMetricPayload]) {
        for payload in payloads {
            guard let exits = payload.applicationExitMetrics.map(Self.abnormalExits) else { continue }
            let counts = exits.reported
            guard !counts.isEmpty else { continue }
            AppLog.error("metrickit_abnormal_exits \(counts.sorted { $0.key < $1.key }.map { "\($0.key)=\($0.value)" }.joined(separator: " "))")
            record(domain: "MetricKit.exit", code: counts.values.reduce(0, +), info: counts.mapValues { $0 as Any })
        }
    }

    // MARK: - Diagnostics (MXDiagnosticPayload: crashes, hangs, CPU and disk)

    func didReceive(_ payloads: [MXDiagnosticPayload]) {
        for payload in payloads {
            for d in payload.hangDiagnostics ?? [] {
                report("hang", d.jsonRepresentation(), ["hang_seconds": d.hangDuration.converted(to: .seconds).value])
            }
            for d in payload.cpuExceptionDiagnostics ?? [] {
                report("cpu_exception", d.jsonRepresentation(), [:])
            }
            for d in payload.diskWriteExceptionDiagnostics ?? [] {
                report("disk_write_exception", d.jsonRepresentation(), [:])
            }
            // A crash Crashlytics caught is reported by it already; MetricKit's copy
            // also covers one it couldn't (a kill in the broadcast extension's host).
            for d in payload.crashDiagnostics ?? [] {
                var info: [String: Any] = [:]
                if let reason = d.terminationReason { info["termination_reason"] = reason }
                if let signal = d.signal { info["signal"] = signal.intValue }
                report("crash", d.jsonRepresentation(), info)
            }
        }
    }

    private func report(_ kind: String, _ json: Data, _ info: [String: Any]) {
        AppLog.error("metrickit_\(kind)")
        #if !DEBUG
        // The payload's head as a breadcrumb: stacks and build, no user content.
        if FirebaseApp.app() != nil, let text = String(data: json.prefix(8_000), encoding: .utf8) {
            Crashlytics.crashlytics().log("metrickit \(kind): \(text)")
        }
        #endif
        record(domain: "MetricKit.\(kind)", code: 0, info: info)
    }

    private func record(domain: String, code: Int, info: [String: Any]) {
        #if !DEBUG
        guard FirebaseApp.app() != nil else { return }
        Crashlytics.crashlytics().record(error: NSError(domain: domain, code: code, userInfo: info))
        #endif
    }
}

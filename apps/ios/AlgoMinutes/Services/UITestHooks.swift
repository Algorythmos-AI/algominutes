import Foundation

/// Launch arguments the UI tests pass to steer the app (docs/runbooks/device-tests.md). Read in Debug builds
/// only: a TestFlight or App Store build ignores them.
enum UITestHooks {
    /// `-AMUITestClientVersion 0.9.0`: the version the app reports to the api (X-AlgoMinutes-Client), so a test
    /// meets the update screen from the real server's 426 rather than from a stub.
    static let clientVersionArgument = "-AMUITestClientVersion"

    static let clientVersion: String? = {
        #if DEBUG
        return clientVersion(arguments: ProcessInfo.processInfo.arguments)
        #else
        return nil
        #endif
    }()

    /// The value after `-AMUITestClientVersion`, when there is one.
    static func clientVersion(arguments: [String]) -> String? {
        guard let flag = arguments.firstIndex(of: clientVersionArgument), flag + 1 < arguments.count else { return nil }
        let version = arguments[flag + 1].trimmingCharacters(in: .whitespaces)
        return version.isEmpty || version.hasPrefix("-") ? nil : version
    }
}

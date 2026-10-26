import DeviceCheck
import Foundation

/// A10 #7: DeviceCheck attestation for trial anti-abuse.
///
/// Generates an Apple DeviceCheck token that the client sends as the
/// `X-Device-Attestation` header (with `X-Device-Platform: ios`) on the
/// process/kickoff request. The server asks Apple with it whether this device
/// has had a trial, and marks it when the trial starts (RELEASE.md PR 22;
/// `services/api/src/device-check.js`), so a reinstall can't start another.
/// See `packages/contracts/src/schemas/compliance.ts` (`DeviceAttestation`).
///
/// `generateToken` returns nil on the Simulator and on devices where
/// DeviceCheck is unsupported: the header is then omitted, and the server
/// starts no trial on that device.
enum DeviceAttestationService {
    static let platformHeaderValue = "ios"

    /// A base64 DeviceCheck token, or nil when unavailable (Simulator /
    /// unsupported device / failed twice). Never throws into callers —
    /// attestation is best-effort and must not block a legitimate action.
    static func attestationToken() async -> String? {
        await attestationToken(
            supported: DCDevice.current.isSupported,
            generate: { try await DCDevice.current.generateToken() },
            wait: { try? await Task.sleep(for: .seconds(1)) }
        )
    }

    /// A failed token is asked for once more, a second later (plan rev 12 S8): the token decides a new user's
    /// trial, and a user's row is never changed afterwards, so one passing failure left them on the free floor for
    /// good. The seams are for tests.
    static func attestationToken(
        supported: Bool,
        generate: () async throws -> Data,
        wait: () async -> Void
    ) async -> String? {
        guard supported else {
            AppLog.info("devicecheck_unsupported")
            return nil
        }
        for attempt in 1...2 {
            do {
                return try await generate().base64EncodedString()
            } catch {
                AppLog.error("devicecheck_token_failed: attempt \(attempt): \(error.localizedDescription)")
                if attempt == 1 { await wait() }
            }
        }
        return nil
    }
}

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
    /// unsupported device / transient failure). Never throws into callers —
    /// attestation is best-effort and must not block a legitimate action.
    static func attestationToken() async -> String? {
        let device = DCDevice.current
        guard device.isSupported else {
            AppLog.info("devicecheck_unsupported")
            return nil
        }
        do {
            let data = try await device.generateToken()
            return data.base64EncodedString()
        } catch {
            AppLog.error("devicecheck_token_failed: \(error.localizedDescription)")
            return nil
        }
    }
}

import DeviceCheck
import Foundation

/// A10 #7: DeviceCheck attestation for trial anti-abuse.
///
/// Generates an Apple DeviceCheck token that the client sends as the
/// `X-Device-Attestation` header (with `X-Device-Platform: ios`) on the
/// process/kickoff request. The server hashes it into `trial_device_hash` and
/// refuses a second fresh trial from the same device. See
/// `packages/contracts/src/schemas/compliance.ts` (`DeviceAttestation`).
///
/// TODO(A4-apple): real DeviceCheck validation requires the Apple DeviceCheck
/// private key configured server-side; that half can't be exercised here. This
/// wires the CLIENT token generation + header injection now. `generateToken`
/// also returns nil on the Simulator and on devices where DeviceCheck is
/// unsupported — the header is simply omitted in that case, and the server
/// falls back to its account-level trial checks.
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

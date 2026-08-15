import Foundation

/// Swift mirror of the A10 compliance constants in
/// `packages/contracts/src/limits.ts`. Swift can't import the TS source, so
/// these are duplicated here and MUST be kept in sync — bump when the TS
/// `TERMS_VERSION` / `PRIVACY_VERSION` / `RETENTION_OPTIONS_DAYS` change.
///
/// A version bump requires re-acceptance (see `AppEnvironment.recordTermsAcceptanceIfNeeded`).
enum ComplianceContract {
    /// Bump when the Terms document changes. Mirrors `TERMS_VERSION`.
    static let termsVersion = "2026-08-16"
    /// Bump when the Privacy Policy changes. Mirrors `PRIVACY_VERSION`.
    static let privacyVersion = "2026-08-16"

    /// User-selectable note-retention windows, in days. Mirrors
    /// `RETENTION_OPTIONS_DAYS`. `nil` (a separate option in the UI) means
    /// "keep until I delete" — `DEFAULT_RETENTION_DAYS` is null server-side.
    static let retentionOptionsDays: [Int] = [30, 90, 180, 365]
}

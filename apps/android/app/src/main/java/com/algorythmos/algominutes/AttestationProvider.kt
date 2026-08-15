package com.algorythmos.algominutes

/**
 * Device-attestation SEAM (BUILD-PLAN A10 #7 · see `docs/BLOCKERS.md` "Trial
 * state-machine fragilities" #1 and `docs/DECISIONS.md`).
 *
 * ## Why this exists
 * The 7-day trial is keyed to the (anonymous) Firebase uid, and `ensureTrial`
 * is idempotent per-uid — but a user can delete + reinstall to mint a *new*
 * anonymous uid and a fresh trial. The server has a `trial_device_hash` column
 * that is a **seam, not enforced**. Closing it needs a durable per-device
 * signal the server can verify: on Android that is **Play Integrity**, on iOS
 * DeviceCheck / App Attest.
 *
 * ## Contract
 * The client obtains a short-lived attestation token and sends it on the
 * process / trial-kickoff request as two headers, so the server can bind the
 * trial to the device:
 * - `X-Device-Attestation: <token>`
 * - `X-Device-Platform: android`
 *
 * This module is headless (no HTTP client — B2 adds Retrofit/Ktor). So the
 * provider only *produces* the header values; the B2 API client attaches
 * [attestationHeaders] to the kickoff request. Field/header names match the
 * iOS client and the server contract.
 *
 * ## Status — stub only, NO fake token
 * The real path needs Play Console setup (Play Integrity API enablement, cloud
 * project link) **and** server-side verification of the token. Neither exists
 * yet, so [PlayIntegrityAttestationProvider.attestationToken] returns `null`
 * (→ [attestationHeaders] returns empty → the kickoff request simply omits the
 * headers, unchanged from today). We do **not** fabricate a token — a fake
 * would give false assurance and could not be verified server-side.
 */
interface AttestationProvider {

    /**
     * A fresh device-attestation token to bind the trial to this device, or
     * `null` when attestation is unavailable/not-yet-wired (the caller then
     * sends no attestation headers). `suspend` because the real Play Integrity
     * call is async.
     */
    suspend fun attestationToken(): String?

    /**
     * The request headers to attach to the process / trial-kickoff request.
     * Empty when [attestationToken] is `null` (stub / unsupported device), so
     * the request is byte-for-byte unchanged until Play Integrity is wired.
     */
    suspend fun attestationHeaders(): Map<String, String> {
        val token = attestationToken() ?: return emptyMap()
        return mapOf(
            HEADER_ATTESTATION to token,
            HEADER_PLATFORM to PLATFORM_ANDROID,
        )
    }

    companion object {
        /** Header carrying the platform attestation token. */
        const val HEADER_ATTESTATION = "X-Device-Attestation"

        /** Header naming the attestation platform, so the server picks the verifier. */
        const val HEADER_PLATFORM = "X-Device-Platform"

        /** Value for [HEADER_PLATFORM] on Android (Play Integrity). */
        const val PLATFORM_ANDROID = "android"
    }
}

/**
 * Play Integrity attestation provider — **stub**.
 *
 * TODO(B2): implement with the Play Integrity API
 * (`com.google.android.play:integrity`): request an integrity token
 * (`StandardIntegrityManager` / `IntegrityManager`) bound to a server-issued
 * nonce/request-hash, and return the encoded token from [attestationToken].
 * Requires Play Console setup (enable Play Integrity, link the cloud project).
 * TODO(A4-apple): the matching iOS seam is DeviceCheck / App Attest, sending
 * the same `X-Device-Attestation` header with `X-Device-Platform: ios`.
 *
 * Until both the client integration AND server-side token verification exist,
 * this returns `null` (no headers sent, no fake token).
 */
class PlayIntegrityAttestationProvider : AttestationProvider {
    override suspend fun attestationToken(): String? {
        // TODO(B2): call Play Integrity here and return the real token.
        // Intentionally null until Play Console + server verification are ready.
        return null
    }
}

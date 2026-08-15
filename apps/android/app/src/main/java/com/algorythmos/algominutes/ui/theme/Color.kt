package com.algorythmos.algominutes.ui.theme

import androidx.compose.ui.graphics.Color

/**
 * AlgoMinutes color tokens.
 *
 * TODO(brand A6.5): provisional palette — final hue/typeface pending brand
 * sign-off. Values mirror packages/tokens/tokens.json (the single source of
 * truth), matching the web `@theme` and the SwiftUI `Theme`.
 *
 * NOTE: there is no Compose app yet (that is BUILD-PLAN B2). These theme files
 * exist so B2 starts on-brand; they are intentionally NOT wired into any Gradle
 * build target here — B2 does that.
 */

// ── brand.* ──────────────────────────────────────────────
val AmAccent = Color(0xFF5B67F0)
val AmAccentHover = Color(0xFF454FD6)
val AmAccentActive = Color(0xFF3A43BE)
val AmOnAccent = Color(0xFFFFFFFF)

// ── color.dark.* ─────────────────────────────────────────
val AmDarkBg = Color(0xFF0B0B10)
val AmDarkBg2 = Color(0xFF111119)
val AmDarkSurface = Color(0xFF16161F)
val AmDarkCard = Color(0xFF14141C)
val AmDarkCardHover = Color(0xFF1C1C27)
val AmDarkBorder = Color(0xFF2A2A38)
val AmDarkHeading = Color(0xFFF5F6FA)
val AmDarkBody = Color(0xFFC8CAD6)
val AmDarkMuted = Color(0xFF8A8D9C)
val AmDarkPlaceholder = Color(0xFF5A5D6E)

// ── color.light.* ────────────────────────────────────────
val AmLightBg = Color(0xFFFFFFFF)
val AmLightBg2 = Color(0xFFF5F6FA)
val AmLightSurface = Color(0xFFFFFFFF)
val AmLightCard = Color(0xFFFFFFFF)
val AmLightCardHover = Color(0xFFF0F1F7)
val AmLightBorder = Color(0xFFE2E4ED)
val AmLightHeading = Color(0xFF14151A)
val AmLightBody = Color(0xFF3B3E4A)
val AmLightMuted = Color(0xFF6B6E7B)
val AmLightPlaceholder = Color(0xFF9A9DA8)

// ── color.status.* ───────────────────────────────────────
val AmSuccess = Color(0xFF22C55E)
val AmWarning = Color(0xFFF5B841)
val AmDanger = Color(0xFFEF4444)
val AmInfo = Color(0xFF5B67F0)

package com.algorythmos.algominutes.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable

/**
 * AlgoMinutes Material3 theme.
 *
 * TODO(brand A6.5): provisional palette — final hue/typeface pending brand
 * sign-off. Colors come from [Color.kt], which mirrors
 * packages/tokens/tokens.json (the single source of truth for web, iOS, and
 * Compose).
 *
 * NOTE: there is no Compose app yet — that is BUILD-PLAN B2. This wires the
 * palette so B2 starts on-brand. It is deliberately NOT added to any Gradle
 * build target here; B2 will do that (and can add Typography/Shapes to match
 * the tokens type scale + radius).
 *
 * Dark is the app's primary surface; a light scheme is provided for
 * system-preference support.
 */

private val AlgoMinutesDarkColors = darkColorScheme(
    primary = AmAccent,
    onPrimary = AmOnAccent,
    primaryContainer = AmAccentActive,
    onPrimaryContainer = AmOnAccent,
    secondary = AmAccentHover,
    onSecondary = AmOnAccent,
    tertiary = AmInfo,
    onTertiary = AmOnAccent,
    background = AmDarkBg,
    onBackground = AmDarkBody,
    surface = AmDarkSurface,
    onSurface = AmDarkHeading,
    surfaceVariant = AmDarkCard,
    onSurfaceVariant = AmDarkMuted,
    surfaceContainerHighest = AmDarkCardHover,
    outline = AmDarkBorder,
    outlineVariant = AmDarkPlaceholder,
    error = AmDanger,
    onError = AmOnAccent,
)

private val AlgoMinutesLightColors = lightColorScheme(
    primary = AmAccent,
    onPrimary = AmOnAccent,
    primaryContainer = AmAccentHover,
    onPrimaryContainer = AmOnAccent,
    secondary = AmAccentHover,
    onSecondary = AmOnAccent,
    tertiary = AmInfo,
    onTertiary = AmOnAccent,
    background = AmLightBg,
    onBackground = AmLightBody,
    surface = AmLightSurface,
    onSurface = AmLightHeading,
    surfaceVariant = AmLightBg2,
    onSurfaceVariant = AmLightMuted,
    surfaceContainerHighest = AmLightCardHover,
    outline = AmLightBorder,
    outlineVariant = AmLightPlaceholder,
    error = AmDanger,
    onError = AmOnAccent,
)

@Composable
fun AlgoMinutesTheme(
    // Dark is AlgoMinutes' primary surface; follow the system by default.
    darkTheme: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit,
) {
    val colorScheme = if (darkTheme) AlgoMinutesDarkColors else AlgoMinutesLightColors
    MaterialTheme(
        colorScheme = colorScheme,
        // TODO(brand A6.5): wire Typography (tokens typography.scale) and Shapes
        //  (tokens radius.*) in B2 once the Compose app exists.
        content = content,
    )
}

# Xcode Cloud → TestFlight (plan PR-30)

Xcode Cloud archives the app and uploads it to TestFlight; nothing is archived on a laptop. The repo
side is `apps/ios/ci_scripts/ci_post_clone.sh`:

1. it stamps the build number from `CI_BUILD_NUMBER` (TestFlight needs a new one per upload);
2. it writes `GoogleService-Info.plist` from the workflow's secret variable `GOOGLE_SERVICE_INFO_PLIST_B64`
   (never committed; a Staging or Release archive without it fails in the app's own build script);
3. it generates the Xcode project from `apps/ios/project.yml` (XcodeGen; the project isn't committed).

## Owner steps (once)

These need your Apple account, so they're yours:

1. **App Store Connect:** the app record for `com.algorythmos.algominutes` exists, the agreements are
   accepted, and there's an internal testing group with your testers.
2. **Generate the project locally** so Xcode can create the workflow:
   ```bash
   cd apps/ios && xcodegen generate && open AlgoMinutes.xcodeproj
   ```
3. In Xcode: **Product → Xcode Cloud → Create Workflow**, and grant Xcode Cloud access to the GitHub repo
   `Algorythmos-AI/algominutes` when asked.
4. Workflow **"Staging → TestFlight"**:
   - **Start condition:** branch changes on `integration`, with files matching `apps/ios/**`, plus manual start.
   - **Environment:** the latest release Xcode (26.x) and macOS.
   - **Environment variable:** `GOOGLE_SERVICE_INFO_PLIST_B64`, marked **Secret**, whose value is the staging
     plist in base64:
     ```bash
     base64 -i apps/ios/AlgoMinutes/Resources/GoogleService-Info.plist | pbcopy
     ```
     That plist is the staging Firebase iOS app (`1:627101926311:ios:…`, project `algominutes-staging`).
   - **Action:** Archive, iOS, scheme **`AlgoMinutes-Staging`**, distribution **TestFlight (Internal Testing Only)**.
   - **Post-action:** TestFlight Internal Testing → your internal group.
5. Start it manually once. A green run shows "Ready to Test" in TestFlight. The build log's post-clone step
   prints the build number and `Firebase project: algominutes-staging`.

## Later

- **"Release → TestFlight"** on `main`: scheme `AlgoMinutes`, archive configuration Release, with the
  production plist (once `algominutes-prod` exists: BLOCKERS "Prod Firebase").
- Unit tests stay on GitHub Actions (`.github/workflows/ios.yml`, free for a public repo); Xcode Cloud is
  only for archiving.

## If the workflow can't find the project

Xcode Cloud runs `ci_scripts/` from the folder the workflow's project path points at (`apps/ios`), and
`ci_post_clone.sh` creates the project there before Xcode opens it. If a run fails with "project not
found" before the post-clone step, fall back to committing the generated project: drop
`*.xcodeproj` from `apps/ios/.gitignore`, commit `apps/ios/AlgoMinutes.xcodeproj`, and add a CI drift
check (`xcodegen generate && git diff --exit-code apps/ios/AlgoMinutes.xcodeproj`) to `ios.yml`.

# Xcode Cloud → TestFlight (plan PR-30)

Xcode Cloud archives the app and uploads it to TestFlight; nothing is archived on a laptop. The repo side
is two scripts in `apps/ios/ci_scripts/`.

**`ci_post_clone.sh`** runs after the clone:

1. It stamps the build number from `CI_BUILD_NUMBER` (TestFlight needs a new one per upload).
2. It writes `GoogleService-Info.plist` from the workflow's secret variable
   `GOOGLE_SERVICE_INFO_PLIST_B64` (never committed). It then checks the plist has `CLIENT_ID`,
   `REVERSED_CLIENT_ID`, `GOOGLE_APP_ID` and `PROJECT_ID`, and is for `com.algorythmos.algominutes`. A
   wrong or incomplete plist fails here, with its reason.
3. It generates the Xcode project from `apps/ios/project.yml`, with the pinned XcodeGen
   (`scripts/install-xcodegen.sh`, checksum-verified). The project isn't committed.
4. It resolves the Swift packages, and fails if that changes the committed `Package.resolved`. Xcode
   Cloud builds only from that file.

**`ci_post_xcodebuild.sh`** runs after an archive. It writes TestFlight's What to Test
(`what-to-test.sh`: the version, build and commit, `apps/ios/release-notes/what-to-test.txt`, then the
recent app changes; it never fails the build). Then it uploads the archive's dSYMs to Crashlytics, with
3 attempts, then the build fails. So every TestFlight build's crashes are symbolicated. Running the
beta: `testflight-internal.md`.

Package versions are exact in `project.yml`, and `Package.resolved` is committed. To upgrade one:
change the version, run `xcodegen generate` and
`xcodebuild -resolvePackageDependencies -scheme AlgoMinutes`, and commit both. GitHub CI
(`.github/workflows/ios.yml`) checks the same thing on every iOS PR.

## Apple identifiers (registered 2026-09-26, team NY9MS8GSBK)

| Identifier | What it's for |
|---|---|
| App ID `com.algorythmos.algominutes` | The app. App Groups, Push Notifications, Sign in with Apple (primary), In-App Purchase. |
| App ID `com.algorythmos.algominutes.BroadcastExtension` | The broadcast extension. App Groups. |
| App Group `group.com.algorythmos.algominutes` | On both App IDs: the extension hands captures to the app. |
| Services ID `com.algorythmos.algominutes.signin` | Firebase's Apple provider (domain `algominutes-staging.firebaseapp.com`, return URL `…/__/auth/handler`). |
| Key "AlgoMinutes Firebase" | APNs (Sandbox & Production) + Sign in with Apple. Its `.p8` goes into Firebase twice: the Apple provider, and Cloud Messaging's APNs key. Apple allows one download only. |

APNs must be **Sandbox & Production**. TestFlight and App Store builds receive push through production,
and a key's environment can't be changed after it's created.

## Owner steps (once)

These need your Apple account, so they're yours:

1. **App Store Connect:**
   - the app record for `com.algorythmos.algominutes`;
   - the agreements accepted;
   - an internal testing group with your testers.
2. **Generate the project locally** so Xcode can create the workflow:
   ```bash
   cd apps/ios && sh scripts/install-xcodegen.sh
   ```
   ```bash
   cd apps/ios && "$(sh scripts/install-xcodegen.sh)" generate && open AlgoMinutes.xcodeproj
   ```
3. In Xcode: **Product → Xcode Cloud → Create Workflow**. Grant Xcode Cloud access to the GitHub repo
   `Algorythmos-AI/algominutes` when asked.
4. Workflow **"Staging → Internal"**:
   - **Start condition:** branch changes on `integration`, with files matching `apps/ios/**`, plus a
     manual start.
   - **Environment:** **Xcode 26.3** (pinned, not "latest release": GitHub CI uses 26.3, and a different
     Xcode can rewrite `Package.resolved`), with its macOS.
   - **Environment variable:** `GOOGLE_SERVICE_INFO_PLIST_B64`, marked **Secret**. Its value is the
     staging plist in base64:
     ```bash
     base64 -i apps/ios/AlgoMinutes/Resources/GoogleService-Info.plist | pbcopy
     ```
     That plist is the staging Firebase iOS app (`1:627101926311:ios:…`, project `algominutes-staging`).
     Download it again after enabling sign-in providers, so it carries `REVERSED_CLIENT_ID`.
   - **Action:** Archive, iOS, scheme **`AlgoMinutes-Staging`**. Distribution **TestFlight (Internal
     Testing Only)**. A build made that way can never go to external testers, which is intended here.
   - **Post-action:** TestFlight Internal Testing → your internal group.
5. **Build number.** If earlier builds of this bundle id were ever uploaded, set Xcode Cloud's next
   build number above the highest (App Store Connect → Xcode Cloud → Settings).
6. **Start it manually once.** A green run shows "Ready to Test" in TestFlight. The post-clone step
   prints the build number and `Firebase project: algominutes-staging`. The post-xcodebuild step prints
   `What to Test: … characters` and `dSYMs uploaded to Crashlytics`.

## Later

- **"Release → External"** on `main`:
  - scheme `AlgoMinutes`, archive configuration Release;
  - the production plist (once `algominutes-prod` exists: BLOCKERS "Prod Firebase");
  - distribution **TestFlight and App Store**.

  Release has no API origin until prod is applied. Its "Backend origins are set" build phase fails the
  archive until `project.yml` has the production origins (`TODO(prod)`).
- **Unit tests** stay on GitHub Actions (`ios.yml`, free for a public repo). It also builds Staging
  unsigned with a placeholder plist, to check the Google Sign-In URL scheme. Xcode Cloud is only for
  archiving.

## If the workflow can't find the project

Xcode Cloud runs `ci_scripts/` from the folder the workflow's project path points at (`apps/ios`), and
`ci_post_clone.sh` creates the project there before Xcode opens it. If a run fails with "project not found"
before the post-clone step, fall back to committing the generated project:

1. Change `AlgoMinutes.xcodeproj/*` in `apps/ios/.gitignore` to ignore only `xcuserdata`.
2. Commit `apps/ios/AlgoMinutes.xcodeproj`.
3. Add a CI drift check to `ios.yml`: regenerate, then `git diff --exit-code apps/ios/AlgoMinutes.xcodeproj`.

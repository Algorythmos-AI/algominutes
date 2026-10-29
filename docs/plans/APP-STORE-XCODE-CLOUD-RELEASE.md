# Xcode Cloud "Release → App Store": check, next build, archive checks

**Draft for the owner, 2026-10-29.** Checked against `origin/integration` at aa7a8e38 and the merged PRs up to
#530. Nothing here has been run in App Store Connect. Where it stands in the plan: RELEASE.md "Status,
2026-10-27" (phases A–D) and R12.5 Stage 2.

## 0. The workflow exists; the next build needs a promotion

BLOCKERS §0 (2026-10-27) records "Release → App Store" as done: branch `main`, project path `/apps/ios`,
Xcode 26.3, App Store Connect distribution, internal TestFlight. Build 76 (e71a089) printed `Firebase project:
algominutes-production`, uploaded dSYMs on attempt 1, and is 1.0.0 (76) Ready to Submit.

So the job is: **check the workflow against §2, add the external step, and build the next number from `main`
after the next promotion.** §2 doubles as the from-scratch recipe.

Build 76 predates everything merged to `integration` since c354fe12, including #505 and #506 (Gemini 429),
#507 (What to Test en-AU), #508 (recovery), #512 (push token), #517, #519, #520, #526 (deferred DeviceCheck
trial) and #527. Promotion **#525** (integration → `main`) is open with auto-merge on; the owner approves its
production deploy. #528 (the device lane's own Release scheme), #532 (I3) and #533 are still open and would
need a later promotion.

Drift noted, not fixed here: `docs/runbooks/xcode-cloud.md` "Later" still calls the workflow "Release →
External".

## 1. Prerequisites (owner)

1. **Promotion merged and deployed.** #525 green and merged as a merge commit (never a red promotion);
   `deploy-production` green, migrate and smoke included.
2. **Production Firebase iOS app** for `com.algorythmos.algominutes` in `algominutes-production`
   (`docs/runbooks/prod-firebase-config.md` §2), with Google sign-in enabled before the plist was downloaded
   (so it carries `REVERSED_CLIENT_ID`).
3. **The plist** at `~/Secrets/algominutes-prod/GoogleService-Info.plist`. `device-tests.sh --release` reads
   the same default path, and the Release lane ran green from it on 2026-10-28, so the path is right on the
   owner's Mac.
4. **App Store Connect:** app 6816333591, Paid Apps agreement, internal group "AlgoMinutes internal", the
   subscription products (R12.5 Stage 3).
5. **App IDs:** the app has App Groups, Push Notifications, Sign in with Apple, In-App Purchase; the extension
   has App Groups (`docs/runbooks/xcode-cloud.md`).
6. **APNs key** in the production Firebase project's Cloud Messaging. BLOCKERS ("A7.3 real push") still lists
   it open, and I10 (no push token on production) is open. Not verified.
7. **Build number** above 76. Xcode Cloud numbers builds itself (App Store Connect → Xcode Cloud → Settings).

## 2. Workflow settings

App Store Connect → Apps → AlgoMinutes → Xcode Cloud → Manage Workflows → "Release → App Store" → Edit. Menu
labels may differ in today's UI (not verified).

**General.** Repository `Algorythmos-AI/algominutes`. Project path as the Staging workflow has it (BLOCKERS
records `/apps/ios`; the project is generated there by `ci_post_clone.sh`). Restrict editing, if offered.

**Environment.**
- **Xcode 26.3**, pinned, not "Latest Release". `.github/workflows/ios.yml` selects `Xcode_26.3.app` [code];
  another Xcode can rewrite `Package.resolved`, and post-clone then fails on purpose. (The device lane on the
  Mac uses Xcode 27.0; that is separate.)
- Clean build on.
- `GOOGLE_SERVICE_INFO_PLIST_B64`: base64 of the **production** plist (§3), **Secret ticked**. Save, reload,
  check it shows `**********` (on 10-27 it first saved in the clear). Never copy Staging's value.

**Start condition.** Branch Changes on **`main` only**, files under `apps/ios/`, auto-cancel on. Manual start
always works.

**Owner decision: automatic or manual Release builds.** Default: **automatic on `main` with the `apps/ios/`
filter**; promotions that touch only services build nothing.

**Archive.** iOS, scheme **`AlgoMinutes`** (archive config Release in `project.yml`; `ci_post_clone.sh` checks
that scheme `AlgoMinutes` carries `algominutes-production`). Never `AlgoMinutes-Staging`, and never the
device lane's `AlgoMinutes-ReleaseUITests` (#528, if merged). Distribution **App Store Connect** ("TestFlight
and App Store"), not "TestFlight (Internal Testing Only)". Required to pass.

**Post-actions.**
1. TestFlight Internal Testing → "AlgoMinutes internal".
2. TestFlight External Testing: **not automatic**. Add each build by hand after §4, as
   `docs/runbooks/testflight-external.md` does.
3. App Store: there is no submit post-action; the build becomes selectable on the 1.0 version
   (`docs/runbooks/app-store-review.md`).

**Owner decision: which external group gets the production build.** Rev 10 sends it to "AlgoMinutes beta",
whose testers run staging with invite codes; Release has `INVITE_CODES_ENABLED: "NO"` and talks to
production, so their staging notes stay behind. Default: **a new external group for the release candidate**
(for example "AlgoMinutes RC") with production Test Information. Phase B wants ≥20 external testers in Beta
App Review by 11-05.

## 3. The owner's commands for the secret

Nothing is printed but "OK" lines.

```bash
P=~/Secrets/algominutes-prod/GoogleService-Info.plist
[ "$(/usr/libexec/PlistBuddy -c 'Print :PROJECT_ID' "$P")" = algominutes-production ] && echo "project OK"
[ "$(/usr/libexec/PlistBuddy -c 'Print :BUNDLE_ID' "$P")" = com.algorythmos.algominutes ] && echo "bundle OK"
/usr/libexec/PlistBuddy -c 'Print :REVERSED_CLIENT_ID' "$P" >/dev/null 2>&1 && echo "Google sign-in key OK"
base64 -i "$P" | tr -d '\n' | pbcopy
pbpaste | base64 -D | cmp -s - "$P" && echo "clipboard OK"
# paste, tick Secret, save, reload; then:
pbcopy < /dev/null
```

## 4. What the build enforces, and what to check on the archive

**Enforced by the repo [code].**
- `ci_post_clone.sh`: sets `CURRENT_PROJECT_VERSION` to `CI_BUILD_NUMBER` (prints `Build number: N`); writes
  the plist and fails unless it has `PROJECT_ID`, `BUNDLE_ID`, `CLIENT_ID`, `REVERSED_CLIENT_ID`,
  `GOOGLE_APP_ID`, the bundle id matches, and scheme `AlgoMinutes` → `algominutes-production`; installs the
  pinned XcodeGen; fails if `Package.resolved` is missing or changes. A missing variable only prints a note
  here; the build fails later.
- `project.yml` build phases: "Backend origins are set" (Release → `api-43914754953` / `billing-43914754953`);
  the Google Sign-In URL scheme from the plist (fails a non-Debug build with no plist); the local dSYM upload is
  skipped on Xcode Cloud.
- `ci_post_xcodebuild.sh`: What to Test (en-US, copied to en-AU, never fails the build); dSYMs to Crashlytics,
  3 tries, then fails.
- Release values: `MARKETING_VERSION 1.0.0`, `UPDATE_URL itms-apps://apps.apple.com/app/id6816333591`,
  `PAYWALL_ENABLED YES`, `INVITE_CODES_ENABLED NO`.

**Checks on the next archive.**

| # | Check | Pass | Who |
|---|---|---|---|
| 1 | Post-clone log | `Build number: N` (N > 76), `Firebase project: algominutes-production` | Owner |
| 2 | Post-xcodebuild log | `What to Test: … characters`, `dSYMs uploaded to Crashlytics` | Owner |
| 3 | TestFlight | 1.0.0 (N) processed, What to Test filled (proves I12) | Owner |
| 4 | `aps-environment` | `production` in the App Store export | Engineering, on the IPA |
| 5 | No analytics/ads SDK | none of GoogleAppMeasurement, AdSupport, AppTrackingTransparency, AdServices | Engineering, on the IPA |
| 6 | Plist project | `PROJECT_ID` `algominutes-production`; `GOOGLE_APP_ID` contains `43914754953` | Engineering, silent compare |
| 7 | Versions | 1.0.0 / N in the app and the extension | Engineering |
| 8 | Origins | API and billing contain `43914754953`; update URL `itms-apps://` | Engineering |
| 9 | Profile | no `ProvisionedDevices` in `embedded.mobileprovision` | Engineering, count only |
| 10 | Privacy Report | Organizer → Generate Privacy Report matches `STORE-COMPLIANCE.md` §2 | Owner; engineering compares |
| 11 | On a phone | install from TestFlight; a note reaches `ready` on production; a push arrives (I10) | Owner; logs confirm |

The 2026-10-28 `device-tests.sh --release` run (8 passed) covers the Release configuration against production
on a development-signed build; it does not replace checks 4–11, which are about the App Store export.

Download the **App Store** export `.ipa` (not only the `.xcarchive`, whose app is development-signed) into a
new empty folder. Artifact names are not verified.

```bash
D=<empty folder with the .ipa>; cd "$D" && unzip -q *.ipa; APP=Payload/AlgoMinutes.app
codesign -d --entitlements :- "$APP" 2>/dev/null | plutil -extract aps-environment raw -
otool -L "$APP/AlgoMinutes" | grep -i -E 'AdSupport|AppTrackingTransparency|AdServices|AppMeasurement|GoogleMobileAds' || echo "otool: none"
strings -a "$APP/AlgoMinutes" | grep -c -E 'GoogleAppMeasurement|APMMeasurement|GADApplication'   # want 0
G="$APP/GoogleService-Info.plist"
[ "$(/usr/libexec/PlistBuddy -c 'Print :PROJECT_ID' "$G")" = algominutes-production ] && echo "plist project OK"
/usr/libexec/PlistBuddy -c 'Print :GOOGLE_APP_ID' "$G" | grep -q ':43914754953:' && echo "plist app OK"
for k in CFBundleShortVersionString CFBundleVersion AlgoMinutesAPIBaseURL AlgoMinutesBillingBaseURL AlgoMinutesUpdateURL; do
  printf '%s=' "$k"; /usr/libexec/PlistBuddy -c "Print :$k" "$APP/Info.plist"; done
/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$APP/PlugIns/BroadcastExtension.appex/Info.plist"
security cms -D -i "$APP/embedded.mobileprovision" 2>/dev/null | grep -c ProvisionedDevices   # want 0
```

Firebase's SPM products link statically, so `otool -L` can't show GoogleAppMeasurement; the `strings` count
covers it, and `tests/ios-linked-sdks.test.ts` pins the linked products. Whether those symbol names are the
right markers is not verified.

## 5. Failures and fixes

| Symptom | Cause | Fix |
|---|---|---|
| `scheme AlgoMinutes archives against algominutes-production, but … algominutes-staging` | Staging's value pasted | Redo §3 with the prod file |
| `GoogleService-Info.plist has no REVERSED_CLIENT_ID` | Plist downloaded before Google sign-in was on | Enable it, download again, redo §3 |
| `no GoogleService-Info.plist: set GOOGLE_SERVICE_INFO_PLIST_B64` | Variable missing | Add it (§2) |
| `resolving packages changed … Package.resolved` | Xcode other than 26.3 | Pin 26.3 |
| "project not found" before post-clone | Wrong project path | Same path as Staging; fallback in `xcode-cloud.md` |
| dSYM upload fails 3 times | Crashlytics not opened in prod Firebase, or a blip | Open Crashlytics once; Rebuild |
| Signing or profile error | Capability missing on an App ID | Add it (§1.5); Rebuild |
| "bundle version must be higher" | Number collision | Raise the next build number |
| Can't go external or to the App Store | Distribution was Internal Testing Only | Change it; build again |
| What to Test empty | Build before #507 | Check the next build |
| Beta App Review rejects | Staging-era Test Information (invite codes) | Production Test Information: no invite code, trial and sandbox purchase |
| Xcode 26.3 no longer offered | Apple retired it | Bump `ios.yml` and the workflow together; commit `Package.resolved` |

## 6. Who does what

**Owner:** approve #525's production deploy; §3; match §2; decide the external group and its Test
Information; start the build; read checks 1–3; download the App Store export; Privacy Report; install on a
phone; add the build to the external group and submit for Beta App Review.

**Engineering (read-only on the files the owner hands over):** the production Test Information text; checks
4–9; compare the Privacy Report; confirm from production logs that the build's first note reached `ready` and a
push token registered; record the evidence in BLOCKERS §0 in a docs PR.

## Not verified

- The workflow's current settings in App Store Connect, and today's UI labels.
- Whether an external RC group exists.
- Whether the production APNs key is uploaded.
- Xcode Cloud artifact names, and that the App Store export carries `aps-environment production`.
- That the `strings` markers catch GoogleAppMeasurement or ads code.
- That Xcode 26.3 is still offered and meets Apple's current SDK minimum for submission.

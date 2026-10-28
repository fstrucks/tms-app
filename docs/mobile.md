# PowerHaul TMS phone apps (iOS and Android)

The iOS and Android apps are a native shell (Capacitor 8) that loads the hosted web app, plus
native camera and photo picking, the Android back button, status bar and splash handling, and a
bundled offline screen. Web pages, server routes and validation are shared with the website.

| Piece | Where |
| --- | --- |
| Shell config (server URL, allowed domains, splash, status bar) | `capacitor.config.js` |
| App id and display name (one place) | `mobile/app-identity.json` |
| Offline screen (bundled in the app) | `mobile/www/offline.html` |
| Icon and splash sources | `assets/` (generated into `ios/` and `android/`) |
| Native helpers (camera, photos, back button) | `app/lib/native.js`, `app/components/NativeShell.js` |
| iOS project (Xcode, Swift Package Manager) | `ios/App` |
| Android project (Gradle) | `android/` |

Everything native is a no-op in a browser: `isNative()` is false, so the site keeps its normal
file inputs and behaviour.

## Requirements

- Node 22+ for the native tooling (`npx cap ...`). The website itself still builds on the current Node.
- iOS: a Mac with Xcode 26+ (or a hosted macOS runner, such as GitHub macOS runners or Codemagic).
  iOS plugins are pulled with Swift Package Manager, so there is no `pod install` step.
- Android: JDK 21 and the Android SDK (Android Studio, or any Linux/macOS CI runner).

## Everyday commands

```bash
npm ci
npx cap sync            # copies config, offline screen and plugins into ios/ and android/
npx cap open ios        # Xcode (macOS only)
npx cap open android    # Android Studio
cd android && ./gradlew assembleDebug   # debug APK at android/app/build/outputs/apk/debug/
```

Run `npx cap sync` after changing `capacitor.config.js`, `mobile/www`, or the Capacitor packages.
The generated `capacitor.config.json` copies inside the native projects are git-ignored.

## Which server the app loads

The app loads production, `https://tms-app-two-pi.vercel.app`, by default. To build against a
preview deployment, set `CAP_SERVER_URL` when syncing:

```bash
CAP_SERVER_URL=https://tms-app-git-my-branch-fst-tms.vercel.app npx cap sync
```

Navigation inside the app is allowed only to production, `*-fst-tms.vercel.app` previews,
`*.supabase.co`, and the configured server host. Other links open outside the app.
Sync again without the variable before a store build.

## Renaming the app id or name

`com.pwrstrong.powerhaul` is a placeholder. Edit `mobile/app-identity.json`, then:

```bash
node scripts/mobile-identity.mjs          # rewrites the iOS bundle id, Android applicationId and names
node scripts/mobile-identity.mjs --check  # CI check that the projects match the file
npx cap sync
```

The Android Java package (`namespace`) stays as generated; stores only see `applicationId`.

## Icons and splash

Sources are in `assets/` (1024 px icon on the flat brand blue, no transparency; 2732 px light
and dark splash). To regenerate after a logo change:

```bash
npx @capacitor/assets generate --iconBackgroundColor '#2563eb' --iconBackgroundColorDark '#2563eb' \
  --splashBackgroundColor '#2563eb' --splashBackgroundColorDark '#0b1220'
```

Delete any `icons/` folder or `public/manifest.webmanifest` it creates: the website has its own manifest.

## Permissions

Only camera, photo library and foreground location (while the app is open). No background location
or background modes. Strings are in `ios/App/App/Info.plist`; Android permissions are in
`android/app/src/main/AndroidManifest.xml`. Android uses the system photo picker, so no
`READ_MEDIA_*` permission is requested.

## Signing (never commit keys)

Keystores, `.p12`, `.p8`, provisioning profiles and `keystore.properties` are git-ignored.

- **Android:** create an upload keystore, keep it in the team password manager, and enrol in
  Play App Signing. For CI, store it as a base64 secret plus passwords and decode it in the job.
  Build a release bundle with `./gradlew bundleRelease` after adding a `signingConfigs.release`
  block that reads `keystore.properties` (placeholder: `storeFile`, `storePassword`, `keyAlias`, `keyPassword`).
- **iOS:** set the Team in Xcode (Signing & Capabilities) on the Mac or in Codemagic, using the Apple
  Developer account for Power Strong Solutions LLC. Archive with Xcode or `xcodebuild archive`,
  then upload to TestFlight.

## CI

`mobile/ci/android-debug.yml` is a ready GitHub Actions workflow that builds an unsigned debug APK
on pull requests that touch the native project. It uses no secrets. To turn it on, copy it to
`.github/workflows/` (pushing workflow files needs an account with the `workflow` permission). iOS builds need a macOS runner or Codemagic and aren't set up yet.

## Checks only possible on a real device

Camera and photo picker, permission prompts, safe areas on notched phones, the Android back button,
status bar colours in light and dark mode, the splash hiding, and the offline screen (airplane mode, then Retry).

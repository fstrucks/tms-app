// Applies mobile/app-identity.json (app id and display name) to the committed iOS and Android
// projects. Run after editing that file:  node scripts/mobile-identity.mjs   (--check to only verify)
// The Android Java package (namespace) stays as generated; only the store-facing id changes.
import { readFileSync, writeFileSync } from 'node:fs';

const { appId, appName } = JSON.parse(readFileSync('mobile/app-identity.json', 'utf8'));
if (!/^[a-zA-Z][\w]*(\.[a-zA-Z][\w]*)+$/.test(appId)) throw new Error(`Bad appId: ${appId}`);
const xml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

const edits = [
  ['android/app/build.gradle', [[/applicationId "[^"]*"/, `applicationId "${appId}"`]]],
  ['android/app/src/main/res/values/strings.xml', [
    [/(<string name="app_name">)[^<]*/, `$1${xml(appName)}`],
    [/(<string name="title_activity_main">)[^<]*/, `$1${xml(appName)}`],
    [/(<string name="package_name">)[^<]*/, `$1${appId}`],
    [/(<string name="custom_url_scheme">)[^<]*/, `$1${appId}`],
  ]],
  ['ios/App/App.xcodeproj/project.pbxproj', [[/PRODUCT_BUNDLE_IDENTIFIER = [^;]*;/g, `PRODUCT_BUNDLE_IDENTIFIER = ${appId};`]]],
  ['ios/App/App/Info.plist', [[/(<key>CFBundleDisplayName<\/key>\s*<string>)[^<]*/, `$1${xml(appName)}`]]],
];

const check = process.argv.includes('--check');
let stale = 0;
for (const [file, reps] of edits) {
  const before = readFileSync(file, 'utf8');
  let after = before;
  for (const [re, to] of reps) after = after.replace(re, to);
  if (after !== before) { stale++; if (!check) writeFileSync(file, after); console.log(`${check ? 'out of date' : 'updated'}: ${file}`); }
}
if (check && stale) process.exit(1);
if (!stale) console.log(`Native projects match ${appId} / ${appName}`);

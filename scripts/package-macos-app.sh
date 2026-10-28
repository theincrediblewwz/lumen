#!/usr/bin/env bash
set -euo pipefail

app="${CARGO_TARGET_DIR:?}/universal-apple-darwin/release/bundle/macos/Lumen.app"
test -d "$app"
binary_name=$(/usr/libexec/PlistBuddy -c 'Print CFBundleExecutable' "$app/Contents/Info.plist")
binary="$app/Contents/MacOS/$binary_name"
test -x "$binary"
lipo "$binary" -verify_arch arm64 x86_64
codesign --verify --deep --strict --all-architectures "$app"

output="mac-preview-artifact"
mkdir -p "$output"
short_sha="${GITHUB_SHA:0:7}"
app_zip="Lumen-Mac-${short_sha}-universal.zip"
source_zip="Lumen-Mac-source-${short_sha}.zip"
ditto -c -k --sequesterRsrc --keepParent "$app" "$output/$app_zip"
git -c core.autocrlf=false archive --format=zip --output="$PWD/$output/$source_zip" "$GITHUB_SHA"
cp docs/MAC_TEST.md "$output/Mac测试说明.md"
{
  echo "source_commit=$GITHUB_SHA"
  echo "workflow_run=$GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID"
  echo "version=$(/usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' "$app/Contents/Info.plist")"
  echo "minimum_macos=$(/usr/libexec/PlistBuddy -c 'Print LSMinimumSystemVersion' "$app/Contents/Info.plist")"
  echo "architectures=$(lipo -archs "$binary")"
  echo "signing=ad-hoc; notarization=not-performed"
  echo "native_runtime=normal Lumen; existing storage configuration preserved"
  rustc +1.95.0 --version
  node --version
} > "$output/build-info.txt"
codesign -dv --verbose=4 "$app" 2> "$output/signature.txt"
grep -q 'Signature=adhoc' "$output/signature.txt"
(cd "$output" && shasum -a 256 "$app_zip" "$source_zip" Mac测试说明.md build-info.txt signature.txt > SHA256SUMS.txt)
{
  echo '### Lumen Mac test app'
  echo "Source: \`$GITHUB_SHA\`"
  echo 'Universal .app for Apple Silicon and Intel; ad-hoc signed, not notarized.'
  echo 'Interface tests use actual App/AiApp/ReaderApp in Mac WebKit with synthetic storage.'
} >> "$GITHUB_STEP_SUMMARY"

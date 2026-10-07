#!/usr/bin/env bash
# Rebuilds activity/vendor/embedded-app-sdk.js: Discord's Embedded App SDK and its dependencies as
# one browser file. The page cannot load it from a CDN, because inside Discord every request has to
# go through the Activity's own proxy. The result is committed; run this only to change the version.
set -euo pipefail
SDK_VERSION="2.5.0"
ESBUILD_VERSION="0.28.2"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
cd "$TMP"
npm init -y >/dev/null
npm install --no-audit --no-fund "@discord/embedded-app-sdk@$SDK_VERSION" "esbuild@$ESBUILD_VERSION" >/dev/null
printf 'export { DiscordSDK, Events, Platform } from "@discord/embedded-app-sdk";\n' > entry.mjs
mkdir -p "$HERE/activity/vendor"
npx esbuild entry.mjs --bundle --format=iife --global-name=DiscordEmbeddedAppSDK --minify --target=es2019 \
  --banner:js="/* @discord/embedded-app-sdk $SDK_VERSION, bundled by scripts/build-sdk.sh. Do not edit. */" \
  --outfile="$HERE/activity/vendor/embedded-app-sdk.js"

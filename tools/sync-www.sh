#!/usr/bin/env bash
# Copy the Formora web app (served at the repo root for GitHub Pages) into www/,
# which Capacitor bundles into the native iOS/Android apps.
set -e
cd "$(dirname "$0")/.."
rm -rf www
mkdir -p www
cp index.html www/
cp -R js css assets www/
[ -f version.txt ] && cp version.txt www/ || true
[ -f manifest.webmanifest ] && cp manifest.webmanifest www/ || true
echo "www/ built — $(find www -type f | wc -l | tr -d ' ') files"

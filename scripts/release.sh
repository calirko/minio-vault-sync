#!/usr/bin/env bash
# Build and publish a GitHub release for the Obsidian plugin.
#
# Follows the standard Obsidian community-plugin release convention:
# a git tag matching manifest.json's version (no "v" prefix), with
# main.js, manifest.json, and versions.json attached as release assets
# (styles.css too, if present).
#
# Usage: ./scripts/release.sh

set -euo pipefail
cd "$(dirname "$0")/.."

if [[ -n "$(git status --porcelain)" ]]; then
	echo "Error: working tree is not clean. Commit or stash changes first." >&2
	git status --short
	exit 1
fi

version="$(node -p "require('./manifest.json').version")"
tag="$version"

if git rev-parse "$tag" >/dev/null 2>&1; then
	echo "Error: tag $tag already exists." >&2
	exit 1
fi

echo "Building plugin..."
npm run build

assets=(main.js manifest.json versions.json)
[[ -f styles.css ]] && assets+=(styles.css)

echo "Tagging $tag..."
git tag -a "$tag" -m "$tag"
git push origin "$tag"

echo "Creating GitHub release $tag..."
gh release create "$tag" "${assets[@]}" \
	--title "$tag" \
	--notes "Release $tag"

echo "Done: https://github.com/$(gh repo view --json nameWithOwner -q .nameWithOwner)/releases/tag/$tag"

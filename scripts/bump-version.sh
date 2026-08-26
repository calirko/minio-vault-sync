#!/usr/bin/env bash
# Bump the plugin version and commit the result.
#
# Bumps package.json's version (via `npm version`), which triggers the
# "version" npm script (version-bump.mjs) to sync manifest.json and
# versions.json, then commits package.json, package-lock.json,
# manifest.json, and versions.json together. Does not tag or push —
# run ./scripts/release.sh afterwards to tag and publish a release.
#
# Usage: ./scripts/bump-version.sh [patch|minor|major|<version>]
#   (defaults to "patch")

set -euo pipefail
cd "$(dirname "$0")/.."

bump="${1:-patch}"

if [[ -n "$(git status --porcelain)" ]]; then
	echo "Error: working tree is not clean. Commit or stash changes first." >&2
	git status --short
	exit 1
fi

echo "Bumping version ($bump)..."
new_version="$(npm version "$bump" --no-git-tag-version | sed 's/^v//')"

git add package.json package-lock.json manifest.json versions.json

echo "Committing version $new_version..."
git commit -m "Bump version to $new_version"

echo "Done: version bumped to $new_version."
echo "Next: git push, then ./scripts/release.sh to tag and publish."

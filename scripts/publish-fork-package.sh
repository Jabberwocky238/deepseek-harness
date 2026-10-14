#!/bin/bash
# Build one of the fork's own packages and publish it to npm under the version
# its package.json carries. A version already on the registry is skipped, so
# rerunning after a partial release publishes only what is missing.
#
# Usage: scripts/publish-fork-package.sh <package directory>...
#   e.g. scripts/publish-fork-package.sh packages/ssh/ssh packages/interaction/wecom
#
# Only packages in the fork's scope (@jabberwocky238/) are published. pnpm
# rewrites workspace: ranges to the versions the workspace carries.
set -euo pipefail
cd "$(dirname "$0")/.."
for dir in "$@"; do
  name=$(node -p "require('./$dir/package.json').name")
  version=$(node -p "require('./$dir/package.json').version")
  case "$name" in
    @jabberwocky238/*) ;;
    *) echo "publish-fork-package: $dir is $name, outside the fork's scope" >&2; exit 1 ;;
  esac
  if [ "$(npm view "$name@$version" version 2>/dev/null || true)" = "$version" ]; then
    echo "$name@$version is already published; skipped"
    continue
  fi
  echo "building $name@$version"
  rm -rf "$dir/lib"
  node ./node_modules/typescript/bin/tsc -b "$dir"
  npx tsdown --config-loader native --env.DSH_BUILD_FACE host -F "$name" >/dev/null
  (cd "$dir" && pnpm publish --access public --tag latest --no-git-checks)
done

#!/usr/bin/env bash
#
# Builds and publishes sanbu, keeping both branches on GitHub in step:
#   main      source of truth
#   gh-pages  the built site GitHub Pages serves
#
# This exists because publishing via GitHub Actions needs a token with the
# `workflow` scope, which this machine's login does not have. Once
# `gh auth refresh -h github.com -s workflow` has been run, .github/workflows/
# can be pushed and this script becomes redundant.
#
#   bun run deploy
set -euo pipefail

REMOTE="https://github.com/danielluzhu/sanbu.git"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [[ -n "$(git status --porcelain -- . ':!.github')" ]]; then
  echo "Working tree has uncommitted changes. Commit them first:"
  git status --short -- . ':!.github'
  exit 1
fi

echo "==> Typechecking"
bun run typecheck

echo "==> Building"
bun run build

echo "==> Pushing main"
git push origin main

echo "==> Publishing dist/ to gh-pages"
SHA="$(git rev-parse --short HEAD)"
# A throwaway repository inside dist/ keeps the built output out of main's
# history while still giving Pages a branch to serve.
rm -rf dist/.git
git -C dist init -q -b gh-pages
git -C dist add -A
git -C dist -c user.name="$(git config user.name)" \
             -c user.email="$(git config user.email)" \
             commit -q -m "Deploy sanbu $SHA"
git -C dist push -q -f "$REMOTE" gh-pages:gh-pages
rm -rf dist/.git

echo "==> Waiting for GitHub Pages"
gh api -X POST repos/danielluzhu/sanbu/pages/builds >/dev/null 2>&1 || true
for _ in $(seq 1 40); do
  status="$(gh api repos/danielluzhu/sanbu/pages/builds/latest --jq '.status' 2>/dev/null || echo '')"
  [[ "$status" == "built" ]] && break
  [[ "$status" == "errored" ]] && { echo "Pages build failed"; exit 1; }
  sleep 10
done

code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 25 https://danielluzhu.github.io/sanbu/)"
echo "==> main $SHA · gh-pages published · site HTTP $code"
echo "    https://danielluzhu.github.io/sanbu/"

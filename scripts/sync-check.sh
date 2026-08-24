#!/usr/bin/env bash
#
# Reports whether GitHub matches what is on this machine.
#
#   bun run sync:check
#
# Checks four things:
#   1. nothing uncommitted or untracked that should be committed
#   2. local main == origin/main
#   3. the published gh-pages build was made from the current main
#   4. the live site actually answers
set -uo pipefail

REPO="danielluzhu/sanbu"
SITE="https://danielluzhu.github.io/sanbu/"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

fail=0
ok()   { printf "  \033[32m✓\033[0m %s\n" "$1"; }
bad()  { printf "  \033[31m✗\033[0m %s\n" "$1"; fail=1; }
note() { printf "  \033[33m!\033[0m %s\n" "$1"; }

echo "sync check — $REPO"

# 1. Working tree. .github is excluded because pushing it needs a token scope
#    this machine's login does not have; it is reported separately.
dirty="$(git status --porcelain -- . ':!.github')"
if [[ -z "$dirty" ]]; then
  ok "working tree clean"
else
  bad "uncommitted changes:"
  sed 's/^/      /' <<< "$dirty"
fi

# 2. Branch position.
git fetch -q origin 2>/dev/null || note "could not reach origin"
local_sha="$(git rev-parse HEAD)"
remote_sha="$(git rev-parse origin/main 2>/dev/null || echo none)"
if [[ "$local_sha" == "$remote_sha" ]]; then
  ok "main matches origin/main ($(git rev-parse --short HEAD))"
else
  ahead="$(git rev-list --count origin/main..HEAD 2>/dev/null || echo '?')"
  bad "main differs from origin/main ($ahead commit(s) unpushed)"
fi

# 3. The deploy commit records the source sha it was built from.
deployed="$(gh api "repos/$REPO/commits/gh-pages" --jq '.commit.message' 2>/dev/null | grep -oE '[0-9a-f]{7,}$' || echo '')"
short="$(git rev-parse --short HEAD)"
if [[ -z "$deployed" ]]; then
  bad "could not read the gh-pages deploy marker"
elif [[ "$deployed" == "$short" ]]; then
  ok "gh-pages built from current main ($deployed)"
else
  bad "gh-pages was built from $deployed, main is at $short — run: bun run deploy"
fi

# 4. The site itself.
code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 25 "$SITE" || echo 000)"
[[ "$code" == "200" ]] && ok "site responds 200" || bad "site returned $code"

# Known blocker, reported so it is never quietly forgotten.
if [[ -n "$(git status --porcelain -- .github)" ]]; then
  note ".github/ is not tracked — pushing workflows needs: gh auth refresh -h github.com -s workflow"
fi

echo
[[ $fail -eq 0 ]] && echo "GitHub is consistent with this machine." || echo "GitHub is NOT consistent — see above."
exit $fail

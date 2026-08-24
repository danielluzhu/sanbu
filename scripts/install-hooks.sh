#!/usr/bin/env bash
#
# Installs a post-commit hook that publishes every commit automatically, so
# GitHub stays consistent without anyone having to remember a command.
#
#   bun run hooks:install     install (idempotent)
#   bun run hooks:uninstall   remove
#
# Hooks live in .git/hooks, which is not part of the repository, so this has to
# be run once per clone.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOOK="$ROOT/.git/hooks/post-commit"

if [[ "${1:-install}" == "uninstall" ]]; then
  rm -f "$HOOK"
  echo "post-commit hook removed."
  exit 0
fi

cat > "$HOOK" <<'HOOK'
#!/usr/bin/env bash
# Installed by scripts/install-hooks.sh — publishes each commit to GitHub.
set -uo pipefail

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

# Do not fire part-way through a rebase, merge, cherry-pick or bisect: those
# produce intermediate commits that should not each be published.
GIT_DIR="$(git rev-parse --git-dir)"
for marker in rebase-merge rebase-apply MERGE_HEAD CHERRY_PICK_HEAD BISECT_LOG; do
  if [[ -e "$GIT_DIR/$marker" ]]; then
    echo "post-commit: mid-$marker, skipping publish"
    exit 0
  fi
done

# An explicit escape hatch for a commit that should not ship.
if [[ "${SANBU_NO_DEPLOY:-}" == "1" ]]; then
  echo "post-commit: SANBU_NO_DEPLOY=1, skipping publish"
  exit 0
fi

export PATH="$HOME/.bun/bin:$PATH"

echo "post-commit: publishing to GitHub…"
# --no-wait: the gh-pages push triggers the Pages build on its own, so there is
# no reason to hold the terminal open watching it.
if bash scripts/deploy.sh --no-wait; then
  echo "post-commit: published."
else
  # A hook must never make a commit look like it failed — the commit is already
  # made. Report and move on.
  echo "post-commit: publish FAILED. Run 'bun run deploy' once the cause is fixed." >&2
fi
exit 0
HOOK

chmod +x "$HOOK"
echo "post-commit hook installed at .git/hooks/post-commit"
echo "Every commit now builds and publishes to GitHub."
echo "Skip one with:  SANBU_NO_DEPLOY=1 git commit ..."

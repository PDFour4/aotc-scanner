#!/usr/bin/env bash
#
# Publish the app to GitHub Pages under your own account.
#
#   bash deploy.sh                 first run: creates the repo and publishes
#   bash deploy.sh "some message"  later runs: pushes an update
#
# Requires the GitHub CLI, which handles the login for you:
#   brew install gh && gh auth login
#
set -euo pipefail

REPO="${REPO:-aotc-scanner}"
MSG="${1:-Update}"

command -v gh >/dev/null || { echo "Install the GitHub CLI first:  brew install gh && gh auth login"; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "Sign in first:  gh auth login"; exit 1; }
USER="$(gh api user --jq .login)"

if [ ! -d .git ]; then
  git init -q -b main
  git add -A
  git -c user.email="$(git config user.email || echo you@example.com)" commit -q -m "AOTC Scanner"
fi

if gh repo view "$USER/$REPO" >/dev/null 2>&1; then
  git add -A
  git diff --cached --quiet || git commit -q -m "$MSG"
  git push -q origin main
else
  echo "Creating $USER/$REPO …"
  gh repo create "$REPO" --public --source=. --remote=origin --push
  # Pages can 404 for a few seconds right after the first push; retry briefly.
  for i in 1 2 3 4 5; do
    if gh api -X POST "repos/$USER/$REPO/pages" -f "source[branch]=main" -f "source[path]=/" >/dev/null 2>&1; then
      break
    fi
    sleep 4
  done
fi

URL="https://$USER.github.io/$REPO/"
echo
echo "  Published:  $URL"
echo
echo "  First build takes a minute or two. Then open it on your phone and use"
echo "  Share → Add to Home Screen to install it — it works offline after that."

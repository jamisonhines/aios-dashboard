#!/usr/bin/env bash
# Deploy built plugin files into a vault. Usage: ./deploy.sh [--allow-unmerged] <vault-path>
set -euo pipefail
VAULT=""
ALLOW_UNMERGED=false
for arg in "$@"; do
  case "$arg" in
    --allow-unmerged) ALLOW_UNMERGED=true ;;
    -*) echo "usage: ./deploy.sh [--allow-unmerged] <vault-path>" >&2; exit 1 ;;
    *) if [[ -n "$VAULT" ]]; then
         echo "usage: ./deploy.sh [--allow-unmerged] <vault-path>" >&2; exit 1
       fi
       VAULT="$arg" ;;
  esac
done
if [[ -z "$VAULT" ]]; then
  echo "usage: ./deploy.sh [--allow-unmerged] <vault-path>" >&2; exit 1
fi
INTEGRATION_BRANCH="${AIOS_INTEGRATION_BRANCH:-main}"
HEAD_SHA=$(git rev-parse --short HEAD)
if ! git show-ref --verify --quiet "refs/heads/$INTEGRATION_BRANCH"; then
  echo "Refusing deploy: local integration branch '$INTEGRATION_BRANCH' does not exist (HEAD $HEAD_SHA)." >&2
  exit 1
fi
UNMERGED=false
if ! git merge-base --is-ancestor HEAD "refs/heads/$INTEGRATION_BRANCH"; then
  UNMERGED=true
  echo "HEAD $HEAD_SHA is not contained in integration branch '$INTEGRATION_BRANCH'." >&2
  # Merge in the worktree holding the branch, not the deploying side worktree.
  BRANCH_WORKTREE=""
  WORKTREE=""
  while IFS= read -r line; do
    case "$line" in
      'worktree '*) WORKTREE="${line#worktree }" ;;
      "branch refs/heads/$INTEGRATION_BRANCH") BRANCH_WORKTREE="$WORKTREE" ;;
    esac
  done < <(git -c core.quotePath=false worktree list --porcelain)
  printf 'Fast-forward command: ' >&2
  if [[ -n "$BRANCH_WORKTREE" ]]; then
    printf 'git -C %q merge --ff-only %q\n' "$BRANCH_WORKTREE" "$(git rev-parse HEAD)" >&2
  else
    printf 'git -C %q checkout %q && git -C %q merge --ff-only %q\n' \
      "$(git rev-parse --show-toplevel)" "$INTEGRATION_BRANCH" \
      "$(git rev-parse --show-toplevel)" "$(git rev-parse HEAD)" >&2
  fi
fi
DIRTY=false
if [[ -n "$(git status --porcelain --untracked-files=normal)" ]]; then
  DIRTY=true
  echo "WARNING: dirty working tree; uncommitted changes would be deployed but are in no branch." >&2
fi
if [[ "$UNMERGED" == true || "$DIRTY" == true ]]; then
  if [[ "$ALLOW_UNMERGED" != true ]]; then
    echo "Refusing deploy. Fast-forward the integration branch and commit changes, or use --allow-unmerged for a deliberate preview." >&2
    exit 1
  fi
fi
preview_reminder() {
  if [[ "$ALLOW_UNMERGED" == true ]]; then
    if [[ "$UNMERGED" == true ]]; then
      echo "WARNING: PREVIEW ONLY: HEAD $HEAD_SHA is not in integration branch '$INTEGRATION_BRANCH'; it MUST be merged this session." >&2
    fi
    if [[ "$DIRTY" == true ]]; then
      echo "WARNING: PREVIEW ONLY: dirty changes are in no branch; they MUST be committed and merged into '$INTEGRATION_BRANCH' this session." >&2
    fi
  fi
}
preview_reminder
DST="$VAULT/.obsidian/plugins/aios-dashboard"
npm run build
mkdir -p "$DST"
cp main.js manifest.json styles.css "$DST/"
echo "deployed to $DST"

# Vault exporter scripts: the repo (vault-scripts/) is the canonical home;
# the vault copies under Operations/scripts/ are deploy artifacts.
SCRIPTS_DST="$VAULT/Operations/scripts"
mkdir -p "$SCRIPTS_DST"
cp vault-scripts/*.mjs "$SCRIPTS_DST/"
echo "deployed vault scripts to $SCRIPTS_DST"
preview_reminder

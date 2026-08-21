#!/usr/bin/env bash
# One-time, idempotent setup for the Formora release pipeline.
# Requires the GitHub CLI (`gh`) authenticated as a repo admin.
#
#   bash scripts/setup-pipeline.sh
#
# Safe to re-run: labels use --force, protection is a PUT (upsert).
set -euo pipefail

REPO="ArindamChatterjee007/formora"
REQUIRED_CHECK="validate"   # must match the job name in .github/workflows/ci.yml

echo "== 1/3  Ensuring labels =="
gh label create promotion     --repo "$REPO" --color 1f6feb --description "Automated stage-promotion PR" --force
gh label create bug           --repo "$REPO" --color d73a4a --description "Defect found during testing"  --force
gh label create qa-approved   --repo "$REPO" --color 0e8a16 --description "Test/QA sign-off"             --force
gh label create beta-approved --repo "$REPO" --color 0e8a16 --description "Beta/pre-prod sign-off"       --force

echo "== 2/3  Allowing Actions to open promotion PRs =="
gh api -X PUT "repos/$REPO/actions/permissions/workflow" \
  -F default_workflow_permissions=write \
  -F can_approve_pull_request_reviews=true >/dev/null \
  && echo "  workflow token can now open PRs" \
  || echo "  (could not set automatically - toggle Settings > Actions > General > 'Allow GitHub Actions to create and approve pull requests')"

echo "== 3/3  Protecting release / beta / main (required check: $REQUIRED_CHECK) =="
protect() {
  local b="$1"
  gh api -X PUT "repos/$REPO/branches/$b/protection" --input - >/dev/null <<JSON
{
  "required_status_checks": { "strict": true, "contexts": ["$REQUIRED_CHECK"] },
  "enforce_admins": false,
  "required_pull_request_reviews": null,
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "required_conversation_resolution": true
}
JSON
  echo "  protected: $b"
}
protect release
protect beta
protect main

echo
echo "Done. 'dev' is intentionally left unprotected for fast iteration."
echo "Pipeline: dev -> release -> beta -> main (production / GitHub Pages)."

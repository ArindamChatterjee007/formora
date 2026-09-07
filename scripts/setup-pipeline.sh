#!/usr/bin/env bash
# One-time, idempotent preparation for the Formora release pipeline.
# Requires the GitHub CLI (`gh`) authenticated as a repo admin. It is NOT run automatically:
# a human runs it, reads the output and completes the two manual steps it prints at the end.
#
#   bash scripts/setup-pipeline.sh
#
# Safe to re-run: labels use --force, protection is a PUT (upsert).
set -euo pipefail

REPO="ArindamChatterjee007/formora"
# Must match the job `name:` values in .github/workflows/ci.yml.
REQUIRED_CHECKS='["validate","functional-fixtures","promotion-gate"]'

echo "== 1/3  Ensuring labels =="
gh label create promotion     --repo "$REPO" --color 1f6feb --description "Automated stage-promotion PR" --force
gh label create bug           --repo "$REPO" --color d73a4a --description "Defect found during testing"  --force
gh label create qa-approved   --repo "$REPO" --color 0e8a16 --description "Test/QA sign-off"             --force
gh label create beta-approved --repo "$REPO" --color 0e8a16 --description "Beta/pre-prod sign-off"       --force

echo "== 2/3  Keeping the workflow token read-only by default =="
# Individual workflows request exactly the scopes they need (promote.yml asks for pull-requests: write),
# so the repository default stays read. This deliberately does not touch
# "Allow GitHub Actions to create and approve pull requests": Actions must never approve a pull request,
# because a bot approval is not human sign-off.
gh api -X PUT "repos/$REPO/actions/permissions/workflow" \
  -F default_workflow_permissions=read >/dev/null \
  && echo "  default workflow token permissions = read" \
  || echo "  (could not set automatically - Settings > Actions > General > Workflow permissions > Read repository contents)"

echo "== 3/3  Protecting release / beta / main (required checks: $REQUIRED_CHECKS) =="
protect() {
  local b="$1"
  gh api -X PUT "repos/$REPO/branches/$b/protection" --input - >/dev/null <<JSON
{
  "required_status_checks": { "strict": true, "contexts": $REQUIRED_CHECKS },
  "enforce_admins": true,
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

cat <<'NOTES'

Done. 'dev' is intentionally left unprotected for fast iteration.
Pipeline: dev -> release -> beta -> main (production / GitHub Pages).

"strict" means a promotion PR must be up to date with its base, and new commits invalidate the earlier
run: the required checks must pass again for the new head commit.

No required approving reviews are configured. A single-founder repository cannot self-approve, and an
empty reviewer requirement that only the author can satisfy would be theatre. Add
required_pull_request_reviews (and .github/CODEOWNERS) once there are named reviewers who are not the
author.

STILL MANUAL - this script does not create them, and the promotion gate refuses without them:

  1. GitHub environments `formora-qat-accepted` and `formora-beta-accepted`, each with required
     reviewers who are authorised to accept that stage. promotion-gate only checks that a successful
     deployment to those environments exists for the exact head commit; the gate is only as strong as
     those reviewer settings and the source-bound QA evidence behind each acceptance. Code cannot
     manufacture human approval.
  2. For optional stage previews: repository variable FORMORA_STAGE_PREVIEWS_ENABLED=true,
     variables CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_PAGES_PROJECT, secret CLOUDFLARE_API_TOKEN, and the
     GitHub environments formora-dev / formora-qat / formora-beta. Each stage needs its own Pages
     project whose name carries the stage segment. If a project's production branch is not that stage
     branch, the deployment is a branch alias, not the project's root origin.

NOTES

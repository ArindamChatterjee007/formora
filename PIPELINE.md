# Formora release pipeline

Code flows in **one direction** through four branches. Each arrow is a GitHub
pull request that is **created automatically** once the previous stage passes
CI; a human merges it after that stage's testing is signed off.

```
feature/* ──▶ dev ──▶ release ──▶ beta ──▶ main
              build     QA/test    staging   production → GitHub Pages
```

| Branch    | Owner            | Purpose                                           | Protected |
| --------- | ---------------- | ------------------------------------------------- | --------- |
| `dev`     | Dev team         | Integrate features; fast iteration                | No        |
| `release` | **Test/QA team** | Full manual test pass; bugs filed as issues       | Yes (CI)  |
| `beta`    | Release owner    | Production-parity re-test; confirm nothing broke  | Yes (CI)  |
| `main`    | Release owner    | Production — auto-deploys to the live site        | Yes (CI)  |

Live site: https://arindamchatterjee007.github.io/formora/

## Daily flow

1. Branch from `dev`: `git checkout dev && git pull && git checkout -b feature/my-fix`
2. Open a PR into `dev`. The `validate` check must pass; merge it.
3. When `dev` is green, a **Promote: dev → release** PR opens automatically.
   Merge it when the feature is ready for QA.
4. The test team tests the `release` branch and files defects with the
   **Bug report** issue template. When green, they merge the auto-opened
   **release → beta** PR.
5. Do a final production-parity check on `beta`, then merge the
   **beta → main** PR to ship. Pages redeploys `main` within ~1 minute.

Merging a promotion PR is the "sign-off" — nothing advances until a human
merges, and CI must be green to merge.

## CI gate — `.github/workflows/ci.yml`

Runs on every push/PR to the four branches and fails the merge unless:

- every `js/**/*.js` parses (no syntax errors),
- `index.html` cache-bust `?v=N` and `var V = N` all match `version.txt`,
- no unescaped `src="${…}"` / `href="${…}"` in the feed (stored-XSS guard),
- no leftover merge-conflict markers.

## Cutting a version

Bump `version.txt` and every `?v=` + `var V =` in `index.html` **on `dev`**,
then let the change flow up. CI blocks the merge if they disagree.

## First-time setup / hardening

Run once with an admin `gh` login:

```bash
bash scripts/setup-pipeline.sh
```

It creates the labels, lets Actions open promotion PRs, and protects
`release` / `beta` / `main` with the required `validate` check. Admins can
still bypass in an emergency (`enforce_admins` is off).

To add **human sign-off gates** when you have teammates: list reviewers in
`.github/CODEOWNERS` and raise `required_approving_review_count` for the
protected branches.

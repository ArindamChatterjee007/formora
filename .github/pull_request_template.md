## What changed

<!-- Brief summary of the change. Link any related bug issues, e.g. "Closes #12". -->

## Stage checklist

- [ ] `version.txt` and every `?v=` + `var V =` in `index.html` are bumped and match (CI enforces this)
- [ ] No unescaped user input in rendered HTML (CI guards `src`/`href`; check text sinks use `esc()`)
- [ ] Manually smoke-tested the affected feature

## Testing sign-off

<!-- For release -> beta and beta -> main promotion PRs -->

- [ ] Full test pass completed for this stage
- [ ] All bugs raised are triaged (fixed, or explicitly deferred)
- [ ] Nothing regressed in existing features

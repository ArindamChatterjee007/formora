# Formora — Performance Requirements & Budget

Performance is a **product requirement**, not an afterthought. These budgets are
enforced automatically by the `perf-budget` job in
[.github/workflows/ci.yml](.github/workflows/ci.yml) (static byte budgets) and
verified at runtime with the Playwright Performance API before each release.

Aligned with **ISO/IEC 25010 → Performance efficiency** (time-behaviour,
resource-utilization, capacity). See [docs/ISO_COMPLIANCE.md](ISO_COMPLIANCE.md).

## 1. Payload budgets (enforced in CI on every push)

| Asset            | Budget (raw) | Baseline (v94) | Gate |
| ---------------- | ------------ | -------------- | ---- |
| All JS (`js/*.js`)  | ≤ 430 KB  | 362 KB         | CI fails build if exceeded |
| All CSS (`css/*.css`) | ≤ 100 KB | 87 KB         | CI fails build if exceeded |
| Single JS file   | ≤ 160 KB     | app.js 131 KB  | CI warns |
| Initial requests | ≤ 25         | 19             | runtime check |

## 2. Runtime budgets (mid-tier mobile / throttled)

| Metric                          | Budget   | Measured (warm) |
| ------------------------------- | -------- | --------------- |
| TTFB                            | ≤ 200 ms | 23 ms           |
| First Contentful Paint          | ≤ 2.0 s  | fast (<0.1 s warm) |
| DOM Interactive                 | ≤ 1.5 s  | 51 ms           |
| JS heap after load              | ≤ 30 MB  | 4 MB            |
| Transferred bytes (gzip, initial) | ≤ 200 KB | ~155 KB       |

## 3. Scalability budgets (feed rendering)

| Metric                              | Budget            | Measured |
| ----------------------------------- | ----------------- | -------- |
| Build 500 post-cards (string)       | ≤ 150 ms          | 8 ms     |
| Inject 500 post-cards (innerHTML)   | ≤ 200 ms          | 22 ms    |
| Render scaling vs linear (100→500)  | ≤ 1.3× (no O(n²)) | 0.78×    |
| DOM nodes per post                  | ≤ 45              | 35       |

## 4. How it is tested

1. **CI (automated, every push):** `perf-budget` sums `js/*.js` and `css/*.css`
   bytes and fails if over budget — no oversized asset can reach `main`.
2. **Pre-release (staging):** a Playwright script reloads the app and reads
   `performance.getEntriesByType('navigation'|'resource'|'paint')`,
   `performance.memory`, and a synthetic 100→500 post-card render to confirm the
   runtime and scalability budgets above.
3. **Regression:** any change that pushes a metric past budget blocks promotion
   through `dev → release → beta → main`.

## 5. Optimisation backlog (tracked, not yet required)

- Bundle + minify the 13 JS files into one (cuts requests 19→~7 and ~35% bytes).
- Add feed pagination / list virtualization before the community exceeds ~200
  posts (avoids many simultaneous `<video>` elements on low-end devices).
- Serve pre-compressed `.br`/`.gz` assets via a CDN in front of Pages.

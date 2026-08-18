/* ============================================================
   CHARTS: lightweight dependency-free SVG charts
   ============================================================ */

const Charts = {
  // line chart for weight over time
  weightLine(el, log, targetKg) {
    const data = [...log].sort((a, b) => a.date.localeCompare(b.date));
    if (data.length < 2) {
      el.innerHTML = `<div class="chart-empty">Log your weight on a few different days to see your trend line.</div>`;
      return;
    }
    const W = 640, H = 240, P = 34;
    const xs = data.map((d) => new Date(d.date).getTime());
    const ys = data.map((d) => d.kg);
    let minY = Math.min(...ys, targetKg ?? Infinity) - 1;
    let maxY = Math.max(...ys, targetKg ?? -Infinity) + 1;
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const sx = (x) => P + ((x - minX) / (maxX - minX || 1)) * (W - 2 * P);
    const sy = (y) => H - P - ((y - minY) / (maxY - minY || 1)) * (H - 2 * P);

    const pts = data.map((d) => `${sx(new Date(d.date).getTime())},${sy(d.kg)}`).join(" ");
    const area = `${sx(minX)},${H - P} ${pts} ${sx(maxX)},${H - P}`;

    const gridY = [minY, (minY + maxY) / 2, maxY]
      .map((v) => `<line x1="${P}" y1="${sy(v)}" x2="${W - P}" y2="${sy(v)}" class="grid"/>
        <text x="4" y="${sy(v) + 4}" class="axis">${v.toFixed(1)}</text>`).join("");

    const target = targetKg
      ? `<line x1="${P}" y1="${sy(targetKg)}" x2="${W - P}" y2="${sy(targetKg)}" class="target"/>
         <text x="${W - P}" y="${sy(targetKg) - 6}" text-anchor="end" class="target-t">target ${targetKg}kg</text>`
      : "";

    const dots = data.map((d) =>
      `<circle cx="${sx(new Date(d.date).getTime())}" cy="${sy(d.kg)}" r="3.5" class="dot"/>`).join("");

    el.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" class="chart">
      <defs>
        <linearGradient id="wgrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="var(--accent)" stop-opacity="0.35"/>
          <stop offset="100%" stop-color="var(--accent)" stop-opacity="0"/>
        </linearGradient>
      </defs>
      ${gridY}${target}
      <polygon points="${area}" fill="url(#wgrad)"/>
      <polyline points="${pts}" class="line"/>
      ${dots}
    </svg>`;
  },

  // horizontal bars for muscle balance
  bars(el, counts) {
    if (!el) return;
    const entries = Object.entries(counts);
    const max = Math.max(1, ...entries.map(([, v]) => v));
    el.innerHTML = entries.map(([k, v]) => {
      const pct = Math.round((v / max) * 100);
      return `<div class="bar-row">
        <span class="bar-label">${SPLITS[k].label}</span>
        <div class="bar-track"><div class="bar-fill" style="width:${pct}%;background:${SPLITS[k].accent}"></div></div>
        <span class="bar-val">${v} sets</span>
      </div>`;
    }).join("");
  },

  // circular progress ring (0–100)
  ring(el, pct, label) {
    if (!el) return;
    pct = Math.max(0, Math.min(100, Math.round(pct || 0)));
    const r = 52, C = 2 * Math.PI * r, off = C * (1 - pct / 100);
    el.innerHTML = `<svg viewBox="0 0 130 130" class="ring">
      <circle cx="65" cy="65" r="${r}" class="ring-bg"/>
      <circle cx="65" cy="65" r="${r}" class="ring-fg" stroke-dasharray="${C.toFixed(1)}" stroke-dashoffset="${off.toFixed(1)}" transform="rotate(-90 65 65)"/>
      <text x="65" y="62" class="ring-pct">${pct}%</text>
      <text x="65" y="84" class="ring-lbl">${label || ""}</text>
    </svg>`;
  },
};

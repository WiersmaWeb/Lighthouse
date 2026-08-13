// We slaan overal numericValue op, niet displayValue. displayValue is een
// afgeronde string ("2.7 s"); numericValue is 2718.4 (ms). Voor een A/B-meting
// heb je die precisie nodig, en je moet er sowieso mee kunnen rekenen.
//
// TTFB (server-response-time) staat bewust bovenaan: voor een cache-plugin is
// dat het meest directe signaal. Gewicht (total-byte-weight) is bijna
// ruisvrij en laat zien of de CSS/JS-optimalisatie uberhaupt aanslaat.
export const METRICS = [
  { key: "ttfb", audit: "server-response-time", label: "TTFB", unit: "ms" },
  { key: "fcp", audit: "first-contentful-paint", label: "FCP", unit: "ms" },
  { key: "lcp", audit: "largest-contentful-paint", label: "LCP", unit: "ms" },
  { key: "speedIndex", audit: "speed-index", label: "Speed Index", unit: "ms" },
  { key: "tbt", audit: "total-blocking-time", label: "TBT", unit: "ms" },
  { key: "tti", audit: "interactive", label: "TTI", unit: "ms" },
  { key: "cls", audit: "cumulative-layout-shift", label: "CLS", unit: "" },
  { key: "bytes", audit: "total-byte-weight", label: "Gewicht", unit: "bytes" },
  // De score staat onderaan met opzet: hij is een niet-lineaire bucketing van
  // bovenstaande metrics, dus rond een knikpunt in de curve levert 100 ms
  // LCP-verschil zomaar 5 punten op en elders bijna niets. Bruikbaar als
  // samenvatting, ongeschikt om een effect aan toe te wijzen.
  { key: "performanceScore", audit: null, label: "Score", unit: "score" },
];

export function extractMetrics(lhr) {
  const out = {};
  for (const metric of METRICS) {
    out[metric.key] = metric.audit
      ? (lhr.audits[metric.audit]?.numericValue ?? null)
      : Math.round(lhr.categories.performance.score * 100);
  }
  return out;
}

export function formatValue(unit, value, { signed = false } = {}) {
  if (value === null || Number.isNaN(value)) return "-";

  const sign = signed && value > 0 ? "+" : "";
  switch (unit) {
    case "ms":
      return `${sign}${value.toFixed(0)} ms`;
    case "bytes":
      return `${sign}${(value / 1024).toFixed(0)} kB`;
    case "score":
      return `${sign}${value.toFixed(1)}`;
    default:
      return `${sign}${value.toFixed(3)}`;
  }
}

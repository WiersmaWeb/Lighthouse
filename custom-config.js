export default {
  extends: "lighthouse:default",
  settings: {
    formFactor: "mobile",
    throttlingMethod: "simulate",
    output: "json",
    onlyCategories: ["performance"],
    onlyAudits: [
      "first-contentful-paint",
      "largest-contentful-paint",
      "cumulative-layout-shift",
      "speed-index",
      "total-blocking-time",
    ],
  },
};

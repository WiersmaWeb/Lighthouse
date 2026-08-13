export default {
  extends: "lighthouse:default",
  settings: {
    formFactor: "mobile",
    // "simulate" (Lantern) rekent de vertraging achteraf uit op basis van de
    // trace, in plaats van hem tijdens het laden op te leggen. Dat is een stuk
    // reproduceerbaarder dan devtools-throttling. Niet wijzigen als je
    // metingen over meerdere sessies wilt vergelijken.
    throttlingMethod: "simulate",
    output: "json",
    // Alleen de performance-categorie. Een onlyAudits-lijst stond hier eerder
    // ook, maar Lighthouse neemt de unie van beide en de categorie trekt de
    // audits toch allemaal binnen: hij beperkte dus niets en verborg wel dat
    // TTFB en gewicht gewoon beschikbaar waren.
    onlyCategories: ["performance"],
  },
};

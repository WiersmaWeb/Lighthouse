import baseConfig from "./custom-config.js";

// Device-instellingen (mobile = Lighthouse default throttling/emulatie,
// desktop = geen mobile-emulatie en snellere throttling). Stonden eerder in
// drie bestanden gekopieerd; leven nu hier zodat elke meting gegarandeerd
// dezelfde emulatie gebruikt.
export const deviceConfigs = {
  mobile: {
    ...baseConfig,
    settings: {
      ...baseConfig.settings,
      formFactor: "mobile",
      screenEmulation: {
        mobile: true,
        width: 412,
        height: 823,
        deviceScaleFactor: 1.75,
        disabled: false,
      },
      throttling: {
        rttMs: 150,
        throughputKbps: 1638.4,
        cpuSlowdownMultiplier: 4,
        requestLatencyMs: 0,
        downloadThroughputKbps: 0,
        uploadThroughputKbps: 0,
      },
    },
  },
  desktop: {
    ...baseConfig,
    settings: {
      ...baseConfig.settings,
      formFactor: "desktop",
      screenEmulation: {
        mobile: false,
        width: 1350,
        height: 940,
        deviceScaleFactor: 1,
        disabled: false,
      },
      throttling: {
        rttMs: 40,
        throughputKbps: 10240,
        cpuSlowdownMultiplier: 1,
        requestLatencyMs: 0,
        downloadThroughputKbps: 0,
        uploadThroughputKbps: 0,
      },
    },
  },
};

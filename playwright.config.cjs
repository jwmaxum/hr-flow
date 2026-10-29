const { defineConfig } = require('@playwright/test');
const { WEB_ORIGIN, assertE2EEnvironment } = require('./scripts/e2e/safety.cjs');

// Loading this config directly must fail before a browser can reach a live backend.
assertE2EEnvironment();

module.exports = defineConfig({
  testDir: './client/e2e',
  testMatch: 'smoke.spec.cjs',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: Boolean(process.env.CI),
  timeout: 150000,
  expect: { timeout: 20000 },
  outputDir: 'test-results/e2e/artifacts',
  // HTML/blob reports and traces retain action arguments. Never record credentials.
  reporter: [['./scripts/e2e/reporter.cjs']],
  use: {
    baseURL: WEB_ORIGIN,
    locale: 'ko-KR',
    timezoneId: 'Asia/Seoul',
    reducedMotion: 'reduce',
    acceptDownloads: true,
    trace: 'off',
    video: 'off',
    screenshot: 'only-on-failure',
    launchOptions: process.env.HR_FLOW_E2E_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.HR_FLOW_E2E_CHROMIUM_EXECUTABLE }
      : {},
  },
  projects: [
    { name: 'chromium-desktop', use: { browserName: 'chromium', viewport: { width: 1440, height: 1000 } } },
    { name: 'chromium-mobile', use: { browserName: 'chromium', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
  ],
});

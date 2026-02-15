// k6 Load Test — ramp browser VUs up/down, each running the full test suite.
// Validates the WS server handles concurrent browser connections correctly.
//
// Usage: k6 run --env WS_PORT=<port> k6/load.js

import { browser } from "k6/browser";
import { check } from "k6";

export const options = {
  scenarios: {
    load: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "10s", target: 3 },
        { duration: "20s", target: 3 },
        { duration: "10s", target: 0 },
      ],
      options: {
        browser: {
          type: "chromium",
        },
      },
    },
  },
  thresholds: {
    checks: ["rate==1.0"],
    iteration_duration: ["p(95)<10000"],
  },
};

export default async function () {
  const port = __ENV.WS_PORT;
  if (!port) throw new Error("WS_PORT env var not set");

  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await page.goto(`http://127.0.0.1:${port}/test/test-page.html`, {
      waitUntil: "networkidle",
    });

    await page.waitForFunction(
      () => {
        const el = document.getElementById("status");
        return el && el.textContent !== "Running...";
      },
      { timeout: 30000 },
    );

    const status = await page.locator("#status").textContent();
    check(status, {
      "all tests passed": (s) => s === "PASS",
    });

    const results = await page.evaluate(() => window.__TEST_RESULTS__);
    if (Array.isArray(results)) {
      const failed = results.filter((r) => !r.passed);
      check(failed, {
        "no individual failures": (f) => f.length === 0,
      });
      if (failed.length > 0) {
        for (const r of failed) {
          console.error(`FAIL [VU ${__VU}]: ${r.name} — ${r.error}`);
        }
      }
    }
  } finally {
    await page.close();
    await context.close();
  }
}

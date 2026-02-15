// k6 Soak Test — constant load for 2 minutes to detect memory leaks,
// connection exhaustion, or latency degradation over time.
//
// Usage: k6 run --env WS_PORT=<port> k6/soak.js

import { browser } from "k6/browser";
import { check } from "k6";
import { Trend, Counter } from "k6/metrics";

const soakIterationMs = new Trend("soak_iteration_ms", true);
const soakErrors = new Counter("soak_errors");

export const options = {
  scenarios: {
    soak: {
      executor: "constant-vus",
      vus: 1,
      duration: "2m",
      options: {
        browser: {
          type: "chromium",
        },
      },
    },
  },
  thresholds: {
    checks: ["rate==1.0"],
    soak_iteration_ms: ["p(95)<10000", "p(99)<15000"],
    soak_errors: ["count==0"],
  },
};

export default async function () {
  const port = __ENV.WS_PORT;
  if (!port) throw new Error("WS_PORT env var not set");

  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    const start = Date.now();

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

    const elapsed = Date.now() - start;
    soakIterationMs.add(elapsed);

    const status = await page.locator("#status").textContent();
    const passed = status === "PASS";

    check(passed, {
      [`soak iteration passed (${elapsed}ms)`]: (v) => v,
    });

    if (!passed) {
      soakErrors.add(1);
      const results = await page.evaluate(() => window.__TEST_RESULTS__);
      if (Array.isArray(results)) {
        const failed = results.filter((r) => !r.passed);
        for (const r of failed) {
          console.error(`FAIL [iter ${__ITER}]: ${r.name} — ${r.error}`);
        }
      }
    }
  } finally {
    await page.close();
    await context.close();
  }
}

// k6 browser test — opens test page in real Chromium, verifies all RPC patterns.
//
// Usage: k6 run --env WS_PORT=<port> k6/integration.js

import { browser } from "k6/browser";
import { check } from "k6";

export const options = {
  scenarios: {
    browser: {
      executor: "shared-iterations",
      iterations: 1,
      vus: 1,
      options: {
        browser: {
          type: "chromium",
        },
      },
    },
  },
  thresholds: {
    checks: ["rate==1.0"],
  },
};

export default async function () {
  const port = __ENV.WS_PORT;
  if (!port) {
    throw new Error("WS_PORT env var not set");
  }

  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await page.goto(`http://127.0.0.1:${port}/test/test-page.html`, {
      waitUntil: "networkidle",
    });

    // Wait for tests to complete (status changes from "Running...")
    await page.waitForFunction(
      () => {
        const el = document.getElementById("status");
        return el && el.textContent !== "Running...";
      },
      { timeout: 30000 },
    );

    // Get overall status
    const status = await page.locator("#status").textContent();
    check(status, {
      "all browser tests passed": (s) => s === "PASS",
    });

    // Get individual results
    const results = await page.evaluate(() => window.__TEST_RESULTS__);

    if (Array.isArray(results)) {
      for (const r of results) {
        check(r, {
          [`[browser] ${r.name}`]: (r) => r.passed,
        });
        if (!r.passed) {
          console.error(`FAIL: ${r.name} — ${r.error}`);
        }
      }
    }

    // Print the browser test output
    const logText = await page.locator("#log").textContent();
    console.log("\n--- Browser Test Output ---");
    console.log(logText);
  } finally {
    await page.close();
    await context.close();
  }
}

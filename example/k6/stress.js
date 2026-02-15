// k6 Stress Test — dedicated browser scenarios per RPC pattern.
// Each scenario runs its RPC in a tight loop to find bottlenecks.
//
// Usage: k6 run --env WS_PORT=<port> k6/stress.js

import { browser } from "k6/browser";
import { check, sleep } from "k6";
import { Trend, Counter } from "k6/metrics";

// Custom metrics per RPC pattern
const unaryLatency = new Trend("unary_latency_ms", true);
const serverStreamLatency = new Trend("server_stream_latency_ms", true);
const clientStreamLatency = new Trend("client_stream_latency_ms", true);
const bidiLatency = new Trend("bidi_latency_ms", true);
const concurrentLatency = new Trend("concurrent_latency_ms", true);
const stressErrors = new Counter("stress_errors");

const metricsByTest = {
  unary: unaryLatency,
  "server-stream": serverStreamLatency,
  "client-stream": clientStreamLatency,
  bidi: bidiLatency,
  concurrent: concurrentLatency,
};

export const options = {
  scenarios: {
    unary: {
      executor: "constant-vus",
      vus: 2,
      duration: "30s",
      env: { TEST_NAME: "unary", ITERATIONS: "100" },
      options: { browser: { type: "chromium" } },
    },
    server_stream: {
      executor: "constant-vus",
      vus: 2,
      duration: "30s",
      startTime: "35s",
      env: { TEST_NAME: "server-stream", ITERATIONS: "50" },
      options: { browser: { type: "chromium" } },
    },
    client_stream: {
      executor: "constant-vus",
      vus: 2,
      duration: "30s",
      startTime: "70s",
      env: { TEST_NAME: "client-stream", ITERATIONS: "50" },
      options: { browser: { type: "chromium" } },
    },
    bidi: {
      executor: "constant-vus",
      vus: 2,
      duration: "30s",
      startTime: "105s",
      env: { TEST_NAME: "bidi", ITERATIONS: "50" },
      options: { browser: { type: "chromium" } },
    },
    concurrent: {
      executor: "constant-vus",
      vus: 2,
      duration: "30s",
      startTime: "140s",
      env: { TEST_NAME: "concurrent", ITERATIONS: "30" },
      options: { browser: { type: "chromium" } },
    },
  },
  thresholds: {
    checks: ["rate==1.0"],
    unary_latency_ms: ["p(95)<500"],
    server_stream_latency_ms: ["p(95)<1000"],
    client_stream_latency_ms: ["p(95)<1000"],
    bidi_latency_ms: ["p(95)<1000"],
    concurrent_latency_ms: ["p(95)<2000"],
    stress_errors: ["count==0"],
  },
};

export default async function () {
  const port = __ENV.WS_PORT;
  if (!port) throw new Error("WS_PORT env var not set");

  const testName = __ENV.TEST_NAME || "unary";
  const iterations = __ENV.ITERATIONS || "50";

  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    const url =
      `http://127.0.0.1:${port}/test/stress-page.html` +
      `?test=${testName}&n=${iterations}`;

    await page.goto(url, { waitUntil: "networkidle" });

    // Wait for stress test to complete
    await page.waitForFunction(
      () => {
        const el = document.getElementById("status");
        return el && el.textContent !== "Running..." && !el.textContent.startsWith("Running:");
      },
      { timeout: 120000 },
    );

    const status = await page.locator("#status").textContent();
    check(status, {
      [`${testName} stress passed`]: (s) => s === "PASS",
    });

    // Extract per-iteration latency metrics
    const metrics = await page.evaluate(() => window.__STRESS_METRICS__);

    if (Array.isArray(metrics)) {
      for (const m of metrics) {
        const trend = metricsByTest[m.test];
        if (trend) {
          // Report avg and p99 as individual data points
          trend.add(m.avgMs);
          trend.add(m.p99Ms);
        }
        if (m.errors > 0) {
          stressErrors.add(m.errors);
          console.error(
            `[VU ${__VU}] ${m.test}: ${m.errors}/${m.iterations} errors`,
          );
        }
        console.log(
          `[VU ${__VU}] ${m.test}: ` +
            `${m.completed}/${m.iterations} ok | ` +
            `avg=${m.avgMs.toFixed(1)}ms | ` +
            `p95=${m.p95Ms.toFixed(1)}ms | ` +
            `p99=${m.p99Ms.toFixed(1)}ms | ` +
            `ops/s=${m.opsPerSec.toFixed(1)}`,
        );
      }
    }
  } finally {
    await page.close();
    await context.close();
  }
}

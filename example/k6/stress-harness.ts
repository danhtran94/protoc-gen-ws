// Stress test harness — runs a single RPC pattern in a tight loop.
// Bundled by esbuild, loaded in Chromium via k6.
//
// URL params:
//   ?test=unary|server-stream|client-stream|bidi|concurrent|all
//   &n=50              (iterations, default 50)
//
// Exposes window.__STRESS_METRICS__ for k6 to read.

import { YamuxSession } from "protoc-gen-ws/yamux.js";
import { openStream } from "protoc-gen-ws/transport.js";
import { IdentityServiceWSClient } from "../ts/gen/v1/identity.ws.js";
import { create } from "@bufbuild/protobuf";
import type { SyncUsersResponse } from "../ts/gen/v1/identity_pb.js";
import {
  CreateUserRequestSchema,
  GetUserRequestSchema,
  WatchUsersRequestSchema,
  SyncUsersRequestSchema,
} from "../ts/gen/v1/identity_pb.js";

interface StressMetrics {
  test: string;
  iterations: number;
  completed: number;
  errors: number;
  totalMs: number;
  avgMs: number;
  minMs: number;
  maxMs: number;
  p95Ms: number;
  p99Ms: number;
  opsPerSec: number;
  status: "running" | "done" | "error";
}

const params = new URLSearchParams(location.search);
const testName = params.get("test") || "all";
const iterations = parseInt(params.get("n") || "50", 10);

function log(msg: string) {
  const el = document.getElementById("log")!;
  el.textContent += msg + "\n";
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

// --- Individual RPC test functions (single iteration) ---

async function runUnary(client: IdentityServiceWSClient): Promise<void> {
  const resp = await client.createUser(
    create(CreateUserRequestSchema, {
      email: "stress@example.com",
      username: "stressuser",
      role: "admin",
    }),
  );
  if (resp.user?.id !== "test-id-123") {
    throw new Error(`unexpected id: ${resp.user?.id}`);
  }
}

async function runServerStream(
  client: IdentityServiceWSClient,
): Promise<void> {
  const stream = await client.watchUsers(
    create(WatchUsersRequestSchema, { role: "employee" }),
  );

  let count = 0;
  await new Promise<void>((resolve, reject) => {
    stream.listen({
      onMessage: () => {
        count++;
      },
      onError: (err) => reject(err),
      onEnd: () => resolve(),
    });
  });

  if (count !== 3) {
    throw new Error(`expected 3 events, got ${count}`);
  }
}

async function runClientStream(
  client: IdentityServiceWSClient,
): Promise<void> {
  const stream = await client.importUsers();
  for (let i = 0; i < 5; i++) {
    await stream.send(
      create(CreateUserRequestSchema, {
        email: `s${i}@example.com`,
        username: `s${i}`,
        role: "employee",
      }),
    );
  }
  const resp = await stream.closeAndRecv();
  if (resp.importedCount !== 5) {
    throw new Error(`expected 5, got ${resp.importedCount}`);
  }
}

async function runBidi(client: IdentityServiceWSClient): Promise<void> {
  const stream = await client.syncUsers();
  const ids = ["s1", "s2", "s3"];

  const received: SyncUsersResponse[] = [];
  const done = new Promise<void>((resolve, reject) => {
    stream.listen({
      onMessage: (resp) => received.push(resp),
      onError: (err) => reject(err),
      onEnd: () => resolve(),
    });
  });

  for (const id of ids) {
    await stream.send(
      create(SyncUsersRequestSchema, { type: "subscribe", userId: id }),
    );
  }
  stream.close();
  await done;

  if (received.length !== 3) {
    throw new Error(`expected 3 acks, got ${received.length}`);
  }
}

async function runConcurrent(client: IdentityServiceWSClient): Promise<void> {
  const promises = Array.from({ length: 10 }, async (_, i) => {
    if (i % 2 === 0) {
      await client.createUser(
        create(CreateUserRequestSchema, {
          email: `c${i}@example.com`,
          username: `c${i}`,
          role: "employee",
        }),
      );
    } else {
      await client.getUser(create(GetUserRequestSchema, { id: `id-${i}` }));
    }
  });
  await Promise.all(promises);
}

// --- Raw binary stress tests ---

async function runRawEchoSession(session: YamuxSession): Promise<void> {
  const ws = await openStream(session, "raw.echo");
  const payload = new Uint8Array(256);
  for (let i = 0; i < 256; i++) payload[i] = i;
  await ws.send(payload);
  const result = await ws.recv();
  if (result.length !== 256) throw new Error(`expected 256 bytes, got ${result.length}`);
  ws.close();
}

async function runRawTransformSession(session: YamuxSession): Promise<void> {
  const ws = await openStream(session, "raw.transform");
  const payload = new Uint8Array([0x0f, 0xf0, 0xaa, 0x55]);
  await ws.send(payload);
  const result = await ws.recv();
  if (result[0] !== 0xf0) throw new Error(`XOR failed: ${result[0]}`);
  ws.close();
}

async function runRawUploadSession(session: YamuxSession): Promise<void> {
  const ws = await openStream(session, "raw.upload");
  for (let i = 0; i < 10; i++) {
    await ws.send(new Uint8Array(100).fill(i));
  }
  ws.close();
  const resp = await ws.recv();
  const total = resp[0] | (resp[1] << 8) | (resp[2] << 16) | (resp[3] << 24);
  if (total !== 1000) throw new Error(`expected 1000, got ${total}`);
}

// --- Test registry ---

const tests: Record<
  string,
  (client: IdentityServiceWSClient) => Promise<void>
> = {
  unary: runUnary,
  "server-stream": runServerStream,
  "client-stream": runClientStream,
  bidi: runBidi,
  concurrent: runConcurrent,
};

// Raw binary tests keyed by name — use session directly
const rawTests: Record<
  string,
  (session: YamuxSession) => Promise<void>
> = {
  "raw-echo": runRawEchoSession,
  "raw-transform": runRawTransformSession,
  "raw-upload": runRawUploadSession,
};

// --- Main loop ---

async function main() {
  const wsURL = `ws://${location.host}`;
  log(`stress test: "${testName}" × ${iterations} iterations`);
  log(`connecting to ${wsURL} ...\n`);

  const session = await YamuxSession.connect(wsURL);
  const client = new IdentityServiceWSClient(session);

  // Determine which tests to run
  const allKeys = [...Object.keys(tests), ...Object.keys(rawTests)];
  const testKeys =
    testName === "all" ? allKeys : [testName];

  for (const key of testKeys) {
    const fn = tests[key];
    const rawFn = rawTests[key];
    if (!fn && !rawFn) {
      log(`unknown test: ${key}`);
      continue;
    }

    const latencies: number[] = [];
    let errors = 0;
    const startAll = performance.now();

    const metrics: StressMetrics = {
      test: key,
      iterations,
      completed: 0,
      errors: 0,
      totalMs: 0,
      avgMs: 0,
      minMs: 0,
      maxMs: 0,
      p95Ms: 0,
      p99Ms: 0,
      opsPerSec: 0,
      status: "running",
    };

    // Update live metrics on the page
    const updateStatus = () => {
      document.getElementById("status")!.textContent =
        `Running: ${key} — ${metrics.completed}/${iterations}`;
    };
    updateStatus();

    for (let i = 0; i < iterations; i++) {
      const t0 = performance.now();
      try {
        if (fn) {
          await fn(client);
        } else {
          await rawFn!(session);
        }
        latencies.push(performance.now() - t0);
      } catch (e) {
        errors++;
        latencies.push(performance.now() - t0);
        log(`  ✗ ${key}[${i}]: ${e instanceof Error ? e.message : e}`);
      }
      metrics.completed = i + 1;
      metrics.errors = errors;
      if ((i + 1) % 10 === 0) updateStatus();
    }

    const totalMs = performance.now() - startAll;
    const sorted = [...latencies].sort((a, b) => a - b);

    metrics.totalMs = totalMs;
    metrics.avgMs = sorted.reduce((a, b) => a + b, 0) / sorted.length;
    metrics.minMs = sorted[0] ?? 0;
    metrics.maxMs = sorted[sorted.length - 1] ?? 0;
    metrics.p95Ms = percentile(sorted, 95);
    metrics.p99Ms = percentile(sorted, 99);
    metrics.opsPerSec = (latencies.length / totalMs) * 1000;
    metrics.status = "done";

    log(
      `  ${errors === 0 ? "✓" : "✗"} ${key}: ${latencies.length - errors}/${iterations} ok` +
        ` | avg=${metrics.avgMs.toFixed(1)}ms` +
        ` | p95=${metrics.p95Ms.toFixed(1)}ms` +
        ` | p99=${metrics.p99Ms.toFixed(1)}ms` +
        ` | ops/s=${metrics.opsPerSec.toFixed(1)}` +
        (errors > 0 ? ` | ${errors} errors` : ""),
    );

    // Accumulate per-test metrics for k6
    ((window as any).__STRESS_METRICS__ ??= []).push(metrics);
  }

  session.close();

  const allMetrics: StressMetrics[] = (window as any).__STRESS_METRICS__;
  const totalErrors = allMetrics.reduce((s, m) => s + m.errors, 0);

  const statusEl = document.getElementById("status")!;
  statusEl.textContent = totalErrors === 0 ? "PASS" : "FAIL";
  statusEl.className = totalErrors === 0 ? "pass" : "fail";

  log(
    `\n  done — ${totalErrors === 0 ? "all passed" : `${totalErrors} errors`}`,
  );
}

main().catch((e) => {
  log(`\n  fatal: ${e}`);
  document.getElementById("status")!.textContent = "ERROR";
  document.getElementById("status")!.className = "fail";
  (window as any).__STRESS_METRICS__ = [
    {
      test: "fatal",
      iterations: 0,
      completed: 0,
      errors: 1,
      totalMs: 0,
      avgMs: 0,
      minMs: 0,
      maxMs: 0,
      p95Ms: 0,
      p99Ms: 0,
      opsPerSec: 0,
      status: "error",
    },
  ];
});

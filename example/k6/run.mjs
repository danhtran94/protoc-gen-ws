#!/usr/bin/env node
// Orchestrator: builds browser bundles → starts Go server → runs k6 → cleans up.
//
// Usage:
//   node k6/run.mjs              # smoke (integration.js)
//   node k6/run.mjs load         # load test (ramping VUs)
//   node k6/run.mjs stress       # per-RPC stress test
//   node k6/run.mjs soak         # 2-minute soak test
//   node k6/run.mjs all          # run all sequentially

import { spawn, execSync } from "node:child_process";
import { createInterface } from "node:readline";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const exampleRoot = resolve(__dirname, "..");
const tsRoot = resolve(__dirname, "..", "ts");
const k6Root = __dirname;
const nodePath = resolve(tsRoot, "node_modules");
const execEnv = { ...process.env, NODE_PATH: nodePath };

const mode = process.argv[2] || "smoke";

const scripts = {
  smoke: resolve(k6Root, "integration.js"),
  load: resolve(k6Root, "load.js"),
  stress: resolve(k6Root, "stress.js"),
  soak: resolve(k6Root, "soak.js"),
};

// 1. Build browser bundles
console.log("Building browser bundles...");
execSync(
  [
    `npx esbuild ${resolve(k6Root, "browser-harness.ts")} --bundle --outfile=${resolve(k6Root, "test-bundle.js")} --format=iife --platform=browser`,
    `npx esbuild ${resolve(k6Root, "stress-harness.ts")} --bundle --outfile=${resolve(k6Root, "stress-bundle.js")} --format=iife --platform=browser`,
  ].join(" && "),
  { cwd: tsRoot, stdio: "inherit", env: execEnv },
);

// 2. Start Go test server
console.log("Starting Go test server...");
const goProc = spawn(
  "go",
  ["run", "./server", "-static", "k6"],
  {
    cwd: exampleRoot,
    stdio: ["ignore", "pipe", "inherit"],
    detached: true,
  },
);

function killGo() {
  try {
    process.kill(-goProc.pid, "SIGTERM");
  } catch {
    try {
      goProc.kill("SIGTERM");
    } catch {
      // already dead
    }
  }
}

const port = await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => {
    killGo();
    reject(new Error("Go server did not start within 30s"));
  }, 30_000);

  const rl = createInterface({ input: goProc.stdout });
  rl.on("line", (line) => {
    const match = line.match(/^READY:(\d+)$/);
    if (match) {
      clearTimeout(timeout);
      rl.close();
      resolve(match[1]);
    }
  });

  goProc.on("exit", (code) => {
    clearTimeout(timeout);
    reject(new Error(`Go server exited with code ${code}`));
  });
});

console.log(`Go server ready on port ${port}\n`);

// 3. Run k6 scripts
const toRun = mode === "all" ? ["smoke", "load", "stress", "soak"] : [mode];
let failed = false;

try {
  for (const name of toRun) {
    const script = scripts[name];
    if (!script) {
      console.error(`Unknown mode: ${name}`);
      process.exitCode = 1;
      break;
    }

    console.log(`\n${"=".repeat(60)}`);
    console.log(`  k6 ${name}: ${script}`);
    console.log(`${"=".repeat(60)}\n`);

    try {
      execSync(`k6 run --env WS_PORT=${port} ${script}`, {
        cwd: tsRoot,
        stdio: "inherit",
        env: execEnv,
      });
      console.log(`\n  ✓ ${name} passed`);
    } catch {
      console.error(`\n  ✗ ${name} failed`);
      failed = true;
    }
  }
} finally {
  killGo();
}

if (failed) {
  process.exitCode = 1;
}

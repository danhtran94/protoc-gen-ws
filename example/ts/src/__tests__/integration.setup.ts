import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { resolve } from "node:path";

let goProc: ChildProcess | undefined;

// example/ directory is 3 levels up from src/__tests__/
const exampleRoot = resolve(import.meta.dirname, "../../..");

export async function setup() {
  const proc = spawn("go", ["run", "./server"], {
    cwd: exampleRoot,
    stdio: ["ignore", "pipe", "inherit"],
    detached: true,
  });
  goProc = proc;

  const port = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      killProc(proc);
      reject(new Error("Go test server did not become ready within 30s"));
    }, 30_000);

    const rl = createInterface({ input: proc.stdout! });
    rl.on("line", (line) => {
      const match = line.match(/^READY:(\d+)$/);
      if (match) {
        clearTimeout(timeout);
        rl.close();
        resolve(match[1]);
      }
    });

    proc.on("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`Go test server exited with code ${code}`));
    });
  });

  process.env.WS_TEST_URL = `ws://127.0.0.1:${port}`;
}

export async function teardown() {
  if (!goProc) return;
  const proc = goProc;
  goProc = undefined;

  killProc(proc);
  await new Promise<void>((resolve) => {
    proc.on("exit", () => resolve());
    setTimeout(() => resolve(), 3_000);
  });
}

function killProc(proc: ChildProcess) {
  // Kill the entire process group (go run spawns a child process)
  try {
    process.kill(-proc.pid!, "SIGTERM");
  } catch {
    proc.kill("SIGTERM");
  }
}

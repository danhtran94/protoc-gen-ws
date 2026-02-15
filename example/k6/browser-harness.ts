// Browser test harness — bundled by esbuild, runs in real Chromium via k6.
// Exercises all 5 RPC patterns over the real WebSocket + yamux stack.

import { YamuxSession } from "protoc-gen-ws/yamux.js";
import { RemoteError } from "protoc-gen-ws/stream.js";
import { openStream } from "protoc-gen-ws/transport.js";
import { IdentityServiceWSClient } from "../ts/gen/v1/identity.ws.js";
import { create } from "@bufbuild/protobuf";
import type { SyncUsersResponse, UserEvent } from "../ts/gen/v1/identity_pb.js";
import {
  CreateUserRequestSchema,
  GetUserRequestSchema,
  WatchUsersRequestSchema,
  SyncUsersRequestSchema,
} from "../ts/gen/v1/identity_pb.js";

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
  duration: number;
}

const results: TestResult[] = [];

function log(msg: string) {
  const el = document.getElementById("log")!;
  el.textContent += msg + "\n";
}

function assert(cond: boolean, msg = "assertion failed") {
  if (!cond) throw new Error(msg);
}

function assertEqual<T>(actual: T, expected: T, label = "") {
  if (actual !== expected) {
    throw new Error(
      `${label ? label + ": " : ""}expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

async function test(name: string, fn: () => Promise<void>) {
  const start = performance.now();
  try {
    await fn();
    results.push({ name, passed: true, duration: performance.now() - start });
    log(`  ✓ ${name}`);
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    results.push({
      name,
      passed: false,
      error,
      duration: performance.now() - start,
    });
    log(`  ✗ ${name}: ${error}`);
  }
}

async function main() {
  const wsURL = `ws://${location.host}`;
  log(`connecting to ${wsURL} ...\n`);

  // --- Unary: createUser ---
  await test("createUser roundtrip", async () => {
    const session = await YamuxSession.connect(wsURL);
    try {
      const client = new IdentityServiceWSClient(session);
      const resp = await client.createUser(
        create(CreateUserRequestSchema, {
          email: "test@example.com",
          username: "testuser",
          role: "admin",
        }),
      );
      assert(resp.user !== undefined, "user should be defined");
      assertEqual(resp.user!.id, "test-id-123", "user.id");
      assertEqual(resp.user!.email, "test@example.com", "user.email");
      assertEqual(resp.user!.role, "admin", "user.role");
    } finally {
      session.close();
    }
  });

  // --- Unary: getUser ---
  await test("getUser roundtrip", async () => {
    const session = await YamuxSession.connect(wsURL);
    try {
      const client = new IdentityServiceWSClient(session);
      const resp = await client.getUser(
        create(GetUserRequestSchema, { id: "abc-123" }),
      );
      assert(resp.user !== undefined, "user should be defined");
      assertEqual(resp.user!.id, "abc-123", "user.id");
      assertEqual(resp.user!.email, "found@example.com", "user.email");
    } finally {
      session.close();
    }
  });

  // --- Error propagation ---
  await test("createUser error propagation", async () => {
    const session = await YamuxSession.connect(wsURL);
    try {
      const client = new IdentityServiceWSClient(session);
      try {
        await client.createUser(
          create(CreateUserRequestSchema, {
            email: "error@example.com",
            username: "bad",
            role: "admin",
          }),
        );
        throw new Error("should have thrown");
      } catch (e) {
        assert(
          e instanceof RemoteError,
          `expected RemoteError, got ${(e as Error).constructor.name}`,
        );
        assert(
          (e as RemoteError).message.includes("validation failed"),
          `error should contain "validation failed"`,
        );
      }
    } finally {
      session.close();
    }
  });

  // --- Server stream: watchUsers (listen pattern) ---
  await test("watchUsers server stream via listen()", async () => {
    const session = await YamuxSession.connect(wsURL);
    try {
      const client = new IdentityServiceWSClient(session);
      const stream = await client.watchUsers(
        create(WatchUsersRequestSchema, { role: "employee" }),
      );

      const events: UserEvent[] = [];
      await new Promise<void>((resolve, reject) => {
        stream.listen({
          onMessage: (event) => events.push(event),
          onError: (err) => reject(err),
          onEnd: () => resolve(),
        });
      });

      assertEqual(events.length, 3, "event count");
      assertEqual(events[0].user?.username, "alice", "events[0]");
      assertEqual(events[1].user?.username, "bob", "events[1]");
      assertEqual(events[2].user?.username, "charlie", "events[2]");
    } finally {
      session.close();
    }
  });

  // --- Client stream: importUsers ---
  await test("importUsers client stream", async () => {
    const session = await YamuxSession.connect(wsURL);
    try {
      const client = new IdentityServiceWSClient(session);
      const stream = await client.importUsers();

      for (let i = 0; i < 5; i++) {
        await stream.send(
          create(CreateUserRequestSchema, {
            email: `user${i}@example.com`,
            username: `user${i}`,
            role: "employee",
          }),
        );
      }

      const resp = await stream.closeAndRecv();
      assertEqual(resp.importedCount, 5, "importedCount");
      assertEqual(resp.failedCount, 0, "failedCount");
    } finally {
      session.close();
    }
  });

  // --- Bidi stream: syncUsers (listen pattern) ---
  await test("syncUsers bidi stream via listen()", async () => {
    const session = await YamuxSession.connect(wsURL);
    try {
      const client = new IdentityServiceWSClient(session);
      const stream = await client.syncUsers();
      const ids = ["u1", "u2", "u3"];

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

      assertEqual(received.length, 3, "response count");
      for (let i = 0; i < ids.length; i++) {
        assertEqual(received[i].type, "ack", `received[${i}].type`);
        assertEqual(received[i].user?.id, ids[i], `received[${i}].userId`);
      }
    } finally {
      session.close();
    }
  });

  // --- Concurrent unary ---
  await test("concurrent unary calls (no cross-talk)", async () => {
    const session = await YamuxSession.connect(wsURL);
    try {
      const client = new IdentityServiceWSClient(session);
      const n = 10;
      const promises = Array.from({ length: n }, async (_, i) => {
        if (i % 2 === 0) {
          const resp = await client.createUser(
            create(CreateUserRequestSchema, {
              email: `user${i}@example.com`,
              username: `user${i}`,
              role: "employee",
            }),
          );
          assertEqual(
            resp.user!.email,
            `user${i}@example.com`,
            `user${i} email`,
          );
        } else {
          const resp = await client.getUser(
            create(GetUserRequestSchema, { id: `id-${i}` }),
          );
          assertEqual(resp.user!.id, `id-${i}`, `user id-${i}`);
        }
      });
      await Promise.all(promises);
    } finally {
      session.close();
    }
  });

  // --- Raw binary: unary echo ---
  await test("raw.echo — binary roundtrip", async () => {
    const session = await YamuxSession.connect(wsURL);
    try {
      const ws = await openStream(session, "raw.echo");
      const payload = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x00, 0x80, 0xff]);
      await ws.send(payload);
      const result = await ws.recv();
      assertEqual(result.length, payload.length, "payload length");
      for (let i = 0; i < payload.length; i++) {
        assertEqual(result[i], payload[i], `byte[${i}]`);
      }
      ws.close();
    } finally {
      session.close();
    }
  });

  // --- Raw binary: server stream download ---
  await test("raw.download — server streams binary chunks", async () => {
    const session = await YamuxSession.connect(wsURL);
    try {
      const ws = await openStream(session, "raw.download");
      await ws.send(new Uint8Array([3])); // request 3 chunks
      for (let i = 0; i < 3; i++) {
        const chunk = await ws.recv();
        assertEqual(chunk.length, 64, `chunk[${i}] length`);
        assertEqual(chunk[0], (i * 64) & 0xff, `chunk[${i}] first byte`);
      }
      ws.close();
    } finally {
      session.close();
    }
  });

  // --- Raw binary: client stream upload ---
  await test("raw.upload — client streams binary chunks", async () => {
    const session = await YamuxSession.connect(wsURL);
    try {
      const ws = await openStream(session, "raw.upload");
      for (let i = 0; i < 5; i++) {
        const chunk = new Uint8Array(100);
        chunk.fill(i);
        await ws.send(chunk);
      }
      ws.close();
      const resp = await ws.recv();
      assertEqual(resp.length, 4, "resp length");
      const total = resp[0] | (resp[1] << 8) | (resp[2] << 16) | (resp[3] << 24);
      assertEqual(total, 500, "total bytes");
    } finally {
      session.close();
    }
  });

  // --- Raw binary: bidi XOR transform ---
  await test("raw.transform — bidi XOR", async () => {
    const session = await YamuxSession.connect(wsURL);
    try {
      const ws = await openStream(session, "raw.transform");
      const input = new Uint8Array([0x00, 0x55, 0xaa, 0xff]);
      await ws.send(input);
      const result = await ws.recv();
      assertEqual(result.length, 4, "result length");
      assertEqual(result[0], 0xff, "byte[0]");
      assertEqual(result[1], 0xaa, "byte[1]");
      assertEqual(result[2], 0x55, "byte[2]");
      assertEqual(result[3], 0x00, "byte[3]");
      ws.close();
    } finally {
      session.close();
    }
  });

  // --- Raw binary: large payload (256KB) ---
  await test("raw.echo-large — 256KB binary roundtrip", async () => {
    const session = await YamuxSession.connect(wsURL);
    try {
      const ws = await openStream(session, "raw.echo-large");
      const size = 256 * 1024;
      const payload = new Uint8Array(size);
      for (let i = 0; i < size; i++) {
        payload[i] = i % 251;
      }
      await ws.send(payload);
      const result = await ws.recv();
      assertEqual(result.length, size, "result length");
      // Spot-check a few bytes
      assertEqual(result[0], 0, "byte[0]");
      assertEqual(result[250], 250, "byte[250]");
      assertEqual(result[251], 0, "byte[251]");
      ws.close();
    } finally {
      session.close();
    }
  });

  // --- Raw binary + protobuf mixed on same session ---
  await test("raw binary + protobuf on same session", async () => {
    const session = await YamuxSession.connect(wsURL);
    try {
      // Raw binary call
      const ws = await openStream(session, "raw.echo");
      await ws.send(new Uint8Array([1, 2, 3]));
      const raw = await ws.recv();
      assertEqual(raw.length, 3, "raw length");
      ws.close();

      // Protobuf call on same session
      const client = new IdentityServiceWSClient(session);
      const resp = await client.createUser(
        create(CreateUserRequestSchema, {
          email: "mixed@example.com",
          username: "mixed",
          role: "admin",
        }),
      );
      assertEqual(resp.user!.email, "mixed@example.com", "user.email");
    } finally {
      session.close();
    }
  });

  // --- Summary ---
  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  log(
    `\n  ${passed}/${results.length} passed${failed > 0 ? `, ${failed} failed` : ""}`,
  );

  const statusEl = document.getElementById("status")!;
  statusEl.textContent = failed === 0 ? "PASS" : "FAIL";
  statusEl.className = failed === 0 ? "pass" : "fail";

  // Expose for k6 to read via page.evaluate()
  (window as any).__TEST_RESULTS__ = results;
}

main().catch((e) => {
  log(`\n  fatal: ${e}`);
  const statusEl = document.getElementById("status")!;
  statusEl.textContent = "ERROR";
  statusEl.className = "fail";
  (window as any).__TEST_RESULTS__ = [
    { name: "fatal", passed: false, error: String(e), duration: 0 },
  ];
});

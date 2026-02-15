import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { YamuxSession } from "protoc-gen-ws/yamux.js";
import { WSStream, EOF, RemoteError } from "protoc-gen-ws/stream.js";
import { openStream } from "protoc-gen-ws/transport.js";
import { IdentityServiceWSClient } from "../../gen/v1/identity.ws.js";
import { create } from "@bufbuild/protobuf";
import type { UserEvent, SyncUsersResponse } from "../../gen/v1/identity_pb.js";
import {
  CreateUserRequestSchema,
  GetUserRequestSchema,
  WatchUsersRequestSchema,
  SyncUsersRequestSchema,
} from "../../gen/v1/identity_pb.js";

function getURL(): string {
  const url = process.env.WS_TEST_URL;
  if (!url) throw new Error("WS_TEST_URL not set — is the Go server running?");
  return url;
}

describe("integration: TS client <-> Go server", () => {
  let session: YamuxSession;
  let client: IdentityServiceWSClient;

  beforeEach(async () => {
    session = await YamuxSession.connect(getURL());
    client = new IdentityServiceWSClient(session);
  });

  afterEach(() => {
    session.close();
  });

  // --- Unary ---

  it("createUser roundtrip", async () => {
    const resp = await client.createUser(
      create(CreateUserRequestSchema, {
        email: "test@example.com",
        username: "testuser",
        role: "admin",
      }),
    );
    expect(resp.user).toBeDefined();
    expect(resp.user!.id).toBe("test-id-123");
    expect(resp.user!.email).toBe("test@example.com");
    expect(resp.user!.username).toBe("testuser");
    expect(resp.user!.role).toBe("admin");
  });

  it("getUser roundtrip", async () => {
    const resp = await client.getUser(
      create(GetUserRequestSchema, { id: "abc-123" }),
    );
    expect(resp.user).toBeDefined();
    expect(resp.user!.id).toBe("abc-123");
    expect(resp.user!.email).toBe("found@example.com");
    expect(resp.user!.username).toBe("found-user");
    expect(resp.user!.role).toBe("employee");
  });

  // --- Error ---

  it("createUser error propagation", async () => {
    await expect(
      client.createUser(
        create(CreateUserRequestSchema, {
          email: "error@example.com",
          username: "bad",
          role: "admin",
        }),
      ),
    ).rejects.toThrow(RemoteError);

    try {
      await client.createUser(
        create(CreateUserRequestSchema, {
          email: "error@example.com",
          username: "bad",
          role: "admin",
        }),
      );
    } catch (e) {
      expect(e).toBeInstanceOf(RemoteError);
      expect((e as RemoteError).message).toContain("validation failed");
    }
  });

  // --- Server stream (listen pattern — browser-friendly) ---

  it("watchUsers server stream via listen()", async () => {
    const stream = await client.watchUsers(
      create(WatchUsersRequestSchema, { role: "employee" }),
    );

    // Collect events via onMessage callback — no blocking loop
    const events: UserEvent[] = [];
    await new Promise<void>((resolve, reject) => {
      stream.listen({
        onMessage: (event) => events.push(event),
        onError: (err) => reject(err),
        onEnd: () => resolve(),
      });
    });

    expect(events).toHaveLength(3);
    expect(events.map((e) => e.user?.username)).toEqual([
      "alice",
      "bob",
      "charlie",
    ]);
    expect(events.every((e) => e.type === "created")).toBe(true);
    expect(events.every((e) => e.user?.role === "employee")).toBe(true);
  });

  // --- Client stream ---

  it("importUsers client stream", async () => {
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
    expect(resp.importedCount).toBe(5);
    expect(resp.failedCount).toBe(0);
  });

  // --- Bidi stream (listen pattern — browser-friendly) ---

  it("syncUsers bidi stream via listen()", async () => {
    const stream = await client.syncUsers();
    const ids = ["u1", "u2", "u3"];

    // 1. Start listener — callbacks fire as responses arrive
    const received: SyncUsersResponse[] = [];
    const done = new Promise<void>((resolve, reject) => {
      stream.listen({
        onMessage: (resp) => received.push(resp),
        onError: (err) => reject(err),
        onEnd: () => resolve(),
      });
    });

    // 2. Send requests (could be triggered by UI events in a real app)
    for (const id of ids) {
      await stream.send(
        create(SyncUsersRequestSchema, { type: "subscribe", userId: id }),
      );
    }

    // 3. Close write side — server sees EOF, finishes, listener gets onEnd
    stream.close();
    await done;

    // 4. Verify all acks arrived
    expect(received).toHaveLength(3);
    for (let i = 0; i < ids.length; i++) {
      expect(received[i].type).toBe("ack");
      expect(received[i].user?.id).toBe(ids[i]);
    }
  });

  // --- Concurrent ---

  it("concurrent unary calls (no cross-talk)", async () => {
    const n = 10;
    const promises = Array.from({ length: n }, (_, i) => {
      if (i % 2 === 0) {
        return client
          .createUser(
            create(CreateUserRequestSchema, {
              email: `user${i}@example.com`,
              username: `user${i}`,
              role: "employee",
            }),
          )
          .then((resp) => {
            expect(resp.user!.email).toBe(`user${i}@example.com`);
          });
      } else {
        return client
          .getUser(create(GetUserRequestSchema, { id: `id-${i}` }))
          .then((resp) => {
            expect(resp.user!.id).toBe(`id-${i}`);
          });
      }
    });

    await Promise.all(promises);
  });
});

// ==================== Battle Tests ====================

describe("battle: TS client <-> Go server", () => {
  let session: YamuxSession;
  let client: IdentityServiceWSClient;

  beforeEach(async () => {
    session = await YamuxSession.connect(getURL());
    client = new IdentityServiceWSClient(session);
  });

  afterEach(() => {
    session.close();
  });

  // --- Server stream: empty (handler returns immediately, 0 events) ---

  it("watchUsers empty stream — immediate EOF", async () => {
    const stream = await client.watchUsers(
      create(WatchUsersRequestSchema, { role: "__empty" }),
    );

    const events: UserEvent[] = [];
    await new Promise<void>((resolve, reject) => {
      stream.listen({
        onMessage: (event) => events.push(event),
        onError: (err) => reject(err),
        onEnd: () => resolve(),
      });
    });

    expect(events).toHaveLength(0);
  });

  // --- Server stream: client closes early on infinite stream ---

  it("watchUsers client close early — server stops", async () => {
    const stream = await client.watchUsers(
      create(WatchUsersRequestSchema, { role: "__infinite" }),
    );

    // Read only 3 events from the infinite stream
    const events: UserEvent[] = [];
    for (let i = 0; i < 3; i++) {
      const event = await stream.recv();
      events.push(event);
    }

    expect(events).toHaveLength(3);
    expect(events[0].user?.username).toBe("user-0");
    expect(events[1].user?.username).toBe("user-1");
    expect(events[2].user?.username).toBe("user-2");

    // Close early — server should detect and stop
    stream.close();

    // Session should still be usable after closing one stream
    const resp = await client.createUser(
      create(CreateUserRequestSchema, {
        email: "after-close@example.com",
        username: "still-works",
        role: "admin",
      }),
    );
    expect(resp.user!.email).toBe("after-close@example.com");
  });

  // --- Client stream: large batch (1000 items) ---

  it("importUsers large batch — 1000 items", async () => {
    const stream = await client.importUsers();

    for (let i = 0; i < 1000; i++) {
      await stream.send(
        create(CreateUserRequestSchema, {
          email: `batch${i}@example.com`,
          username: `batch${i}`,
          role: "employee",
        }),
      );
    }

    const resp = await stream.closeAndRecv();
    expect(resp.importedCount).toBe(1000);
    expect(resp.failedCount).toBe(0);
  });

  // --- Bidi stream: client close early, verify EOF ---

  it("syncUsers client close early — recv gets EOF", async () => {
    const stream = await client.syncUsers();

    // Send 1, recv 1
    await stream.send(
      create(SyncUsersRequestSchema, { type: "subscribe", userId: "z1" }),
    );

    const resp = await stream.recv();
    expect(resp.type).toBe("ack");
    expect(resp.user?.id).toBe("z1");

    // Close write side — server sees EOF and returns
    stream.close();

    // Next recv should throw EOF (server finished)
    await expect(stream.recv()).rejects.toThrow(EOF);
  });

  // --- Large payload (100KB username) ---

  it("large payload — 100KB message roundtrip", async () => {
    const bigName = "x".repeat(100 * 1024);

    const resp = await client.createUser(
      create(CreateUserRequestSchema, {
        email: "large@example.com",
        username: bigName,
        role: "admin",
      }),
    );

    expect(resp.user!.username).toBe(bigName);
    expect(resp.user!.username.length).toBe(100 * 1024);
  });

  // --- Concurrent calls at higher scale (30) ---

  it("concurrent 30 calls — mixed unary", async () => {
    const n = 30;
    const promises = Array.from({ length: n }, (_, i) => {
      if (i % 2 === 0) {
        return client
          .createUser(
            create(CreateUserRequestSchema, {
              email: `cc${i}@example.com`,
              username: `cc${i}`,
              role: "employee",
            }),
          )
          .then((resp) => {
            expect(resp.user!.email).toBe(`cc${i}@example.com`);
          });
      } else {
        return client
          .getUser(create(GetUserRequestSchema, { id: `cc-${i}` }))
          .then((resp) => {
            expect(resp.user!.id).toBe(`cc-${i}`);
          });
      }
    });

    await Promise.all(promises);
  });

  // --- Error recovery: error on one call doesn't break session ---

  it("error recovery — session survives errors", async () => {
    // First call: error
    await expect(
      client.createUser(
        create(CreateUserRequestSchema, {
          email: "error@example.com",
          username: "bad",
          role: "admin",
        }),
      ),
    ).rejects.toThrow(RemoteError);

    // Second call: should still work
    const resp = await client.createUser(
      create(CreateUserRequestSchema, {
        email: "ok@example.com",
        username: "good",
        role: "admin",
      }),
    );
    expect(resp.user!.email).toBe("ok@example.com");

    // Third call: error again
    await expect(
      client.createUser(
        create(CreateUserRequestSchema, {
          email: "error@example.com",
          username: "bad2",
          role: "admin",
        }),
      ),
    ).rejects.toThrow(RemoteError);

    // Fourth call: still works
    const resp2 = await client.getUser(
      create(GetUserRequestSchema, { id: "resilient" }),
    );
    expect(resp2.user!.id).toBe("resilient");
  });

  // --- Rapid reconnection: connect, use, close, repeat ---

  it("rapid reconnection — 10 cycles", async () => {
    // Close the session from beforeEach, we manage our own
    session.close();

    for (let i = 0; i < 10; i++) {
      const s = await YamuxSession.connect(getURL());
      const c = new IdentityServiceWSClient(s);

      const resp = await c.createUser(
        create(CreateUserRequestSchema, {
          email: `reconnect${i}@example.com`,
          username: `reconnect${i}`,
          role: "admin",
        }),
      );
      expect(resp.user!.email).toBe(`reconnect${i}@example.com`);

      s.close();
    }

    // Re-establish for afterEach cleanup
    session = await YamuxSession.connect(getURL());
  });

  // --- Multiple stream types on same session ---

  it("mixed streams on same session", async () => {
    // Unary
    const r1 = await client.createUser(
      create(CreateUserRequestSchema, {
        email: "mix1@example.com",
        username: "mix1",
        role: "admin",
      }),
    );
    expect(r1.user!.email).toBe("mix1@example.com");

    // Server stream
    const ss = await client.watchUsers(
      create(WatchUsersRequestSchema, { role: "employee" }),
    );
    const events: UserEvent[] = [];
    await new Promise<void>((resolve, reject) => {
      ss.listen({
        onMessage: (e) => events.push(e),
        onError: reject,
        onEnd: () => resolve(),
      });
    });
    expect(events).toHaveLength(3);

    // Another unary after stream
    const r2 = await client.getUser(
      create(GetUserRequestSchema, { id: "after-stream" }),
    );
    expect(r2.user!.id).toBe("after-stream");

    // Client stream
    const cs = await client.importUsers();
    for (let i = 0; i < 3; i++) {
      await cs.send(
        create(CreateUserRequestSchema, {
          email: `mix${i}@example.com`,
          username: `mix${i}`,
          role: "employee",
        }),
      );
    }
    const csResp = await cs.closeAndRecv();
    expect(csResp.importedCount).toBe(3);

    // Bidi stream
    const bs = await client.syncUsers();
    await bs.send(
      create(SyncUsersRequestSchema, { type: "subscribe", userId: "mx1" }),
    );
    const bsResp = await bs.recv();
    expect(bsResp.user?.id).toBe("mx1");
    bs.close();
  });
});

// ==================== Raw Binary Tests ====================

describe("raw binary: TS client <-> Go server", () => {
  let session: YamuxSession;

  beforeEach(async () => {
    session = await YamuxSession.connect(getURL());
  });

  afterEach(() => {
    session.close();
  });

  it("raw.echo — unary raw binary roundtrip", async () => {
    const ws = await openStream(session, "raw.echo");

    // Send arbitrary binary (not protobuf)
    const payload = new Uint8Array([0x00, 0x01, 0x02, 0xff, 0xfe, 0xfd, 0x00, 0x80]);
    await ws.send(payload);

    const result = await ws.recv();
    expect(result).toEqual(payload);
    ws.close();
  });

  it("raw.download — server streams binary chunks", async () => {
    const ws = await openStream(session, "raw.download");

    // Request 5 chunks (send count as 1 byte)
    await ws.send(new Uint8Array([5]));

    const chunks: Uint8Array[] = [];
    for (let i = 0; i < 5; i++) {
      const chunk = await ws.recv();
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(5);
    for (let i = 0; i < 5; i++) {
      expect(chunks[i].length).toBe(64);
      // Verify first byte pattern
      expect(chunks[i][0]).toBe((i * 64) & 0xff);
    }

    // After all chunks, server returns and stream ends
    ws.close();
  });

  it("raw.upload — client streams binary, gets total back", async () => {
    const ws = await openStream(session, "raw.upload");

    // Send 10 chunks of 100 bytes each
    for (let i = 0; i < 10; i++) {
      const chunk = new Uint8Array(100);
      chunk.fill(i);
      await ws.send(chunk);
    }

    // Half-close to signal done
    ws.close();

    // Read 4-byte LE response (total byte count)
    const resp = await ws.recv();
    expect(resp.length).toBe(4);
    const total = resp[0] | (resp[1] << 8) | (resp[2] << 16) | (resp[3] << 24);
    expect(total).toBe(1000);
  });

  it("raw.transform — bidi XOR transform", async () => {
    const ws = await openStream(session, "raw.transform");

    const payloads = [
      new Uint8Array([0x00, 0x11, 0x22, 0x33]),
      new Uint8Array([0xaa, 0xbb, 0xcc, 0xdd]),
      new Uint8Array([0xff, 0x00, 0xff, 0x00]),
    ];

    for (const p of payloads) {
      await ws.send(p);
      const result = await ws.recv();
      expect(result.length).toBe(p.length);
      for (let i = 0; i < p.length; i++) {
        expect(result[i]).toBe((p[i] ^ 0xff) & 0xff);
      }
    }

    ws.close();
  });

  it("raw.echo-large — 512KB raw binary roundtrip", async () => {
    const ws = await openStream(session, "raw.echo-large");

    // 512KB payload — larger than yamux default window (256KB)
    const size = 512 * 1024;
    const payload = new Uint8Array(size);
    for (let i = 0; i < size; i++) {
      payload[i] = i % 251; // prime modulus to detect corruption
    }

    await ws.send(payload);
    const result = await ws.recv();

    expect(result.length).toBe(size);
    expect(result).toEqual(payload);
    ws.close();
  });

  it("raw binary + protobuf on same session", async () => {
    // First: a raw binary echo
    const rawWs = await openStream(session, "raw.echo");
    const rawPayload = new Uint8Array([0xDE, 0xAD, 0xBE, 0xEF]);
    await rawWs.send(rawPayload);
    const rawResult = await rawWs.recv();
    expect(rawResult).toEqual(rawPayload);
    rawWs.close();

    // Second: a protobuf unary on the same session
    const client = new IdentityServiceWSClient(session);
    const resp = await client.createUser(
      create(CreateUserRequestSchema, {
        email: "after-raw@example.com",
        username: "mixed",
        role: "admin",
      }),
    );
    expect(resp.user!.email).toBe("after-raw@example.com");

    // Third: another raw binary
    const rawWs2 = await openStream(session, "raw.transform");
    await rawWs2.send(new Uint8Array([0x0F]));
    const xored = await rawWs2.recv();
    expect(xored[0]).toBe(0xF0);
    rawWs2.close();
  });
});

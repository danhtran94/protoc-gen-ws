# WebSocket Streaming over Yamux

Protobuf-defined RPC services delivered over a single WebSocket connection using [yamux](https://github.com/hashicorp/yamux) multiplexing. Supports unary, server-streaming, client-streaming, and bidirectional-streaming patterns with full type safety in both Go and TypeScript.

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [Wire Protocol](#wire-protocol)
  - [Yamux Layer](#yamux-layer)
  - [Application Framing Layer](#application-framing-layer)
  - [RPC Dispatch Protocol](#rpc-dispatch-protocol)
- [Go Server](#go-server)
  - [Core Types](#core-types)
  - [Router](#router)
  - [Stream](#stream)
  - [Typed Streams](#typed-streams)
  - [Go Client Helpers](#go-client-helpers)
- [TypeScript Client](#typescript-client)
  - [ByteBuffer](#bytebuffer)
  - [YamuxSession & YamuxStream](#yamuxsession--yamuxstream)
  - [WSStream](#wsstream)
  - [Transport Layer](#transport-layer)
- [Code Generation](#code-generation)
  - [protoc-gen-ws (Go)](#protoc-gen-ws-go)
  - [protoc-gen-ws-ts (TypeScript)](#protoc-gen-ws-ts-typescript)
  - [Plugin Options](#plugin-options)
- [RPC Patterns](#rpc-patterns)
  - [Unary](#unary)
  - [Server Streaming](#server-streaming)
  - [Client Streaming](#client-streaming)
  - [Bidirectional Streaming](#bidirectional-streaming)
- [Raw Binary Streaming](#raw-binary-streaming)
- [Integration Guide](#integration-guide)
  - [Defining Services](#defining-services)
  - [Implementing Handlers](#implementing-handlers)
  - [Mounting the Router](#mounting-the-router)
  - [TypeScript Client Usage](#typescript-client-usage)
- [Error Handling](#error-handling)
- [Testing](#testing)

---

## Architecture Overview

```
Browser (TypeScript)                          Go Server
========================                      ==========================

YamuxSession                                  WSRouter (http.Handler)
  │  one WebSocket connection                   │  upgrades HTTP → WebSocket
  │                                             │  creates yamux.Server
  ├── YamuxStream #1  ──── yamux mux ────────── yamux.Stream #1
  │     WSStream (framing)                        Stream (framing)
  │     callUnary / ServerStream / ...            UnaryHandler / StreamHandler
  │                                               │
  ├── YamuxStream #3  ──── yamux mux ────────── yamux.Stream #3
  │     ...                                       ...  (concurrent RPCs)
  │                                               │
  └── YamuxStream #N  ──── yamux mux ────────── yamux.Stream #N
```

A single WebSocket connection carries a yamux session. Each RPC opens a new yamux stream within that session, allowing unlimited concurrent RPCs without head-of-line blocking. The client uses odd-numbered stream IDs (yamux convention for the initiator).

### Layer Stack

| Layer | Go Server | TypeScript Client | Purpose |
|-------|-----------|-------------------|---------|
| 4 | Generated handlers (`v1ws/`) | Generated client (`identity.ws.ts`) | Typed protobuf RPC |
| 3 | `typed_stream.go` | `transport.ts` | Typed stream wrappers |
| 2 | `stream.go` | `stream.ts` | Application framing (5-byte header) |
| 1 | `router.go` → `yamux.Server` | `yamux.ts` → `YamuxSession` | Multiplexing |
| 0 | `websocket.NetConn` | `WebSocket` (browser) | Transport |

---

## Wire Protocol

### Yamux Layer

Standard [yamux spec](https://github.com/hashicorp/yamux/blob/master/spec.md) over WebSocket binary messages.

```
Yamux header (12 bytes, big-endian):
┌─────────┬──────┬───────┬──────────┬────────┐
│ version │ type │ flags │ streamID │ length │
│  1 byte │ 1 b  │  2 b  │   4 b    │  4 b   │
└─────────┴──────┴───────┴──────────┴────────┘

Types: 0=Data, 1=WindowUpdate, 2=Ping, 3=GoAway
Flags: SYN=0x01, ACK=0x02, FIN=0x04, RST=0x08
```

The Go server uses HashiCorp's `yamux` library with `websocket.NetConn` as the underlying transport. The TypeScript client implements the yamux protocol directly, operating as the session initiator (odd stream IDs).

**Flow control**: Each stream starts with a 256 KB receive window. When more than half the window is consumed, the receiver sends a window update. Writers block (in TS via `Promise`) when the send window is exhausted.

### Application Framing Layer

On top of each yamux stream, a simple 5-byte framing protocol carries typed messages:

```
Application frame (5 + N bytes, little-endian length):
┌──────┬────────────────┬─────────────────┐
│ type │  length (LE)   │    payload      │
│ 1 b  │    4 bytes     │   N bytes       │
└──────┴────────────────┴─────────────────┘

type = 0x00: Data frame (protobuf payload or method name)
type = 0x01: Error frame (UTF-8 error message)
```

Go implementation (`ws/stream.go`):

```go
func WriteFrame(w io.Writer, typ byte, data []byte) error {
    var hdr [5]byte
    hdr[0] = typ
    binary.LittleEndian.PutUint32(hdr[1:], uint32(len(data)))
    if _, err := w.Write(hdr[:]); err != nil {
        return err
    }
    _, err := w.Write(data)
    return err
}

func ReadFrame(r io.Reader) (typ byte, data []byte, err error) {
    var hdr [5]byte
    if _, err := io.ReadFull(r, hdr[:]); err != nil {
        return 0, nil, err
    }
    typ = hdr[0]
    size := binary.LittleEndian.Uint32(hdr[1:])
    data = make([]byte, size)
    if _, err := io.ReadFull(r, data); err != nil {
        return 0, nil, err
    }
    return typ, data, nil
}
```

TypeScript mirror (`ts/src/stream.ts`):

```typescript
async send(data: Uint8Array): Promise<void> {
    const hdr = new Uint8Array(5);
    const view = new DataView(hdr.buffer);
    hdr[0] = 0x00; // FRAME_DATA
    view.setUint32(1, data.length, true); // little-endian
    await this.ys.write(hdr);
    if (data.length > 0) await this.ys.write(data);
}

async recv(): Promise<Uint8Array> {
    const hdr = await this.ys.readExact(5);
    const view = new DataView(hdr.buffer, hdr.byteOffset, hdr.byteLength);
    const typ = hdr[0];
    const length = view.getUint32(1, true); // little-endian
    const payload = length > 0 ? await this.ys.readExact(length) : new Uint8Array(0);
    if (typ === 0x01) throw new RemoteError(new TextDecoder().decode(payload));
    return payload;
}
```

### RPC Dispatch Protocol

Every RPC begins with the client sending a **method frame** — a data frame whose payload is the fully-qualified method name (e.g. `"example.v1.IdentityService/CreateUser"`). The server router reads this first frame to dispatch to the correct handler.

**Unary RPC** (3 frames total):
```
Client → Server: [Data: method name]
Client → Server: [Data: serialized request proto]
Server → Client: [Data: serialized response proto]  OR  [Error: message]
```

**Server streaming** (N+2 frames):
```
Client → Server: [Data: method name]
Client → Server: [Data: serialized request proto]
Server → Client: [Data: response 1]
Server → Client: [Data: response 2]
...
Server → Client: [Data: response N]
Server closes write (FIN) → Client sees EOF
```

**Client streaming** (N+2 frames):
```
Client → Server: [Data: method name]
Client → Server: [Data: request 1]
Client → Server: [Data: request 2]
...
Client closes write (FIN) → Server sees io.EOF
Server → Client: [Data: serialized response proto]
```

**Bidirectional streaming** (interleaved):
```
Client → Server: [Data: method name]
Client ↔ Server: [Data: messages in both directions, interleaved]
Either side closes write (FIN) to signal done
```

---

## Go Server

### Core Types

**`ws/router.go`** — Two handler signatures:

```go
// Unary: receive raw bytes, return a protobuf message
type UnaryHandler func(ctx context.Context, payload []byte) (proto.Message, error)

// Streaming: owns the stream lifecycle
type StreamHandler func(ctx context.Context, stream *Stream)
```

### Router

`WSRouter` implements `http.Handler`. On each HTTP request it:

1. Upgrades to WebSocket via `websocket.Accept`
2. Wraps the WebSocket as `net.Conn` via `websocket.NetConn`
3. Creates a `yamux.Server` session
4. Loops accepting yamux streams, dispatching each in a goroutine

```go
func (r *WSRouter) ServeHTTP(w http.ResponseWriter, req *http.Request) {
    wsConn, err := websocket.Accept(w, req, &websocket.AcceptOptions{
        InsecureSkipVerify: true,
    })
    // ...
    nc := websocket.NetConn(ctx, wsConn, websocket.MessageBinary)
    session, err := yamux.Server(nc, yamux.DefaultConfig())
    // ...
    for {
        ys, err := session.AcceptStream()
        // ...
        go r.dispatch(ctx, ys)
    }
}
```

Dispatch reads the first frame (method name) and routes to the registered handler. Unary handlers get panic recovery via `safeCallUnary`. Stream handlers also get panic recovery with error frame reporting.

### Stream

`Stream` (`ws/stream.go`) wraps a yamux stream with the 5-byte framing protocol:

| Method | Description |
|--------|-------------|
| `Recv() ([]byte, error)` | Read next data frame. Returns `io.EOF` on remote close. Returns `*RemoteError` on error frames. |
| `Send(data []byte) error` | Write a data frame with raw bytes. |
| `SendProto(msg proto.Message) error` | Marshal protobuf and send as data frame. |
| `SendError(msg string) error` | Write an error frame. |
| `Close() error` | Half-close write side (yamux FIN). Read side remains open. |

**Half-close semantics** are critical: `Close()` sends a FIN on the yamux stream, signaling EOF to the remote reader, but the local side can still read until the remote also closes. This enables patterns like client streaming where the client closes its write side and then reads the server's response.

### Typed Streams

`ws/typed_stream.go` provides generic wrappers that handle protobuf marshaling/unmarshaling:

**Server-side types** (used in handler implementations):

| Type | Direction | Purpose |
|------|-----------|---------|
| `ServerStream[T]` | Send only | Server sends multiple `T` messages |
| `ClientStream[T]` | Recv only | Server receives multiple `T` messages from client |
| `BidiStream[Req, Res]` | Both | Server sends `Res`, receives `Req` |

**Client-side types** (used by generated Go client):

| Type | Direction | Purpose |
|------|-----------|---------|
| `ServerStreamClient[T]` | Recv only | Client receives multiple `T` from server |
| `ClientStreamClient[Req, Res]` | Send + CloseAndRecv | Client sends `Req` messages, gets one `Res` at end |
| `BidiStreamClient[Req, Res]` | Both | Client sends `Req`, receives `Res` |

Example — `ClientStreamClient.CloseAndRecv`:

```go
func (s *ClientStreamClient[Req, Res]) CloseAndRecv() (Res, error) {
    if err := s.raw.Close(); err != nil {   // half-close write
        var zero Res
        return zero, err
    }
    data, err := s.raw.Recv()               // read final response
    if err != nil {
        var zero Res
        return zero, err
    }
    msg := s.newRes()
    if err := proto.Unmarshal(data, msg); err != nil {
        var zero Res
        return zero, err
    }
    return msg, nil
}
```

### Go Client Helpers

`ws/client.go` provides two functions for the generated Go client to use:

```go
// CallUnary: open stream → send method → send request → read response → close
func CallUnary(session *yamux.Session, method string, req proto.Message) ([]byte, error)

// OpenStream: open stream → send method → return Stream for streaming patterns
func OpenStream(ctx context.Context, session *yamux.Session, method string) (*Stream, error)
```

---

## TypeScript Client

### ByteBuffer

`ts/src/bytebuffer.ts` — Accumulates incoming byte chunks and provides exact-length reads. This bridges the gap between WebSocket's message-based delivery and yamux's byte-stream protocol.

```typescript
class ByteBuffer {
    push(data: Uint8Array): void    // Append data, resolve pending reads
    readExact(n: number): Promise<Uint8Array>  // Block until N bytes available
    close(err?: Error): void        // Signal no more data; reject pending reads
}
```

Used by both `YamuxSession` (for reading yamux headers) and `YamuxStream` (for reading application data). The `readExact` method returns a `Promise` that resolves only when enough bytes are buffered, enabling sequential reads of fixed-size headers followed by variable-length payloads.

### YamuxSession & YamuxStream

`ts/src/yamux.ts` — Complete client-side yamux implementation.

**YamuxSession**:
- `static connect(url: string): Promise<YamuxSession>` — Connect to WebSocket, establish session
- `open(): Promise<YamuxStream>` — Create a new multiplexed stream (odd IDs, sends SYN)
- `close(): void` — Send GoAway, reset all streams, close WebSocket
- Internal read loop parses yamux frames and dispatches to streams

**YamuxStream**:
- `write(data: Uint8Array): Promise<void>` — Write data, respecting flow control window
- `readExact(n: number): Promise<Uint8Array>` — Read exact bytes from receive buffer
- `closeWrite(): void` — Half-close (sends FIN)
- `reset(): void` — Abort stream (sends RST)

**Flow control**: Each stream starts with `INITIAL_WINDOW = 256 KB`. The receiver automatically sends window updates when more than half is consumed. Writers `await` a Promise when the send window is exhausted, which resolves when a window update arrives.

**Ping handling**: The session read loop automatically responds to server pings with ACK frames.

### WSStream

`ts/src/stream.ts` — Application framing over `YamuxStream`. Mirrors Go's `Stream`:

```typescript
class WSStream {
    async send(data: Uint8Array): Promise<void>  // Write data frame
    async recv(): Promise<Uint8Array>            // Read data frame (throws RemoteError on error frames)
    close(): void                                // Half-close via yamux FIN
}
```

### Transport Layer

`ts/src/transport.ts` — Typed stream classes used by generated client stubs.

**`openStream(session, method)`** — Opens a yamux stream, sends the method name as the first data frame, returns `WSStream`.

**`callUnary(session, method, reqBytes, fromBinary)`** — Complete unary call: open stream, send request, receive response, deserialize.

**`ServerStream<T>`** — Receives multiple typed messages from the server.
- `recv(): Promise<T>` — Pull-based: receive one message
- `listen(callbacks): void` — Push-based: background read loop with `onMessage/onError/onEnd`
- `[Symbol.asyncIterator]` — `for await` support

```typescript
// Pull-based
const stream = await client.watchUsers({ role: "admin" });
while (true) {
    try {
        const event = await stream.recv();
        console.log(event);
    } catch (e) {
        if (e instanceof EOF) break;
        throw e;
    }
}

// Push-based (browser-friendly)
stream.listen({
    onMessage: (event) => updateUI(event),
    onError: (err) => showToast(err.message),
    onEnd: () => setStatus("disconnected"),
});

// Async iteration
for await (const event of stream) {
    console.log(event);
}
```

**`ClientStream<Req, Res>`** — Sends multiple messages, receives one response.
- `send(msg: Req): Promise<void>`
- `closeAndRecv(): Promise<Res>` — Half-close and read final response

**`BidiStream<Req, Res>`** — Full duplex send/receive.
- `send(msg: Req): Promise<void>`
- `recv(): Promise<Res>` / `listen(callbacks)` / `[Symbol.asyncIterator]`
- `close(): void`

---

## Code Generation

Two protoc plugins generate typed RPC code from `.proto` service definitions:

### protoc-gen-ws (Go)

Generates `<service>.ws.go` in a `<pkg>ws/` subdirectory. For each service produces:

| Generated artifact | Description |
|-------------------|-------------|
| `<Service>WSHandler` interface | Handler methods matching each RPC pattern |
| `Register<Service>WS(router, handler)` | Registers all methods with the `WSRouter` |
| `Unimplemented<Service>WSHandler` | Returns errors from all methods (embed for forward compat) |
| `<Service>WSClient` interface | Client methods matching each RPC pattern |
| `New<Service>WSClient(session)` | Constructs a client from a yamux session |

**Handler interface signatures by pattern:**

```go
// Unary
Method(context.Context, *Request) (*Response, error)

// Server streaming
Method(context.Context, *Request, *ws.ServerStream[*Response]) error

// Client streaming
Method(context.Context, *ws.ClientStream[*Request]) (*Response, error)

// Bidi streaming
Method(context.Context, *ws.BidiStream[*Request, *Response]) error
```

### protoc-gen-ws-ts (TypeScript)

Generates `<service>.ws.ts` alongside the protobuf-es generated `_pb.ts` files. For each service produces:

| Generated artifact | Description |
|-------------------|-------------|
| `<Service>Name` constant | Fully-qualified service name |
| `<Service><Method>Method` constants | Fully-qualified method names |
| `<Service>WSClient` class | Typed client with methods for each RPC |

**Client method signatures by pattern:**

```typescript
// Unary
async method(req: Request): Promise<Response>

// Server streaming
async method(req: Request): Promise<ServerStream<Response>>

// Client streaming
async method(): Promise<ClientStream<Request, Response>>

// Bidi streaming
async method(): Promise<BidiStream<Request, Response>>
```

Uses protobuf-es v2 functional API (`toBinary`/`fromBinary` with `Schema` objects).

### Plugin Options

Both plugins accept options via `buf.gen.yaml`:

**protoc-gen-ws**:
- `ws_import` (required) — Go import path for the ws runtime package
- `streaming_only` (optional, default `false`) — Only generate streaming RPCs (server, client, bidi). Skips unary methods, which are better served by Connect-RPC. Services with no streaming methods are omitted entirely.

```yaml
- local: protoc-gen-ws
  out: gen
  opt:
    - paths=source_relative
    - ws_import=github.com/danhtran94/protoc-gen-ws/ws
    - streaming_only=true       # omit unary RPCs (handled by Connect-RPC)
```

**protoc-gen-ws-ts**:
- `runtime_import` (required) — Import path for the TypeScript runtime
  - Relative paths (starting with `.`) are adjusted for proto directory depth
  - Package names are used verbatim
- `streaming_only` (optional, default `false`) — Same as Go: only generate streaming RPCs. When enabled, `callUnary` is not imported.

```yaml
# Relative path mode (for monorepo)
- local: protoc-gen-ws-ts
  out: ts/gen
  opt:
    - paths=source_relative
    - runtime_import=../src     # resolved to ../../src for v1/ depth
    - streaming_only=true

# Package name mode (for published npm package)
- local: protoc-gen-ws-ts
  out: ts/gen
  opt:
    - paths=source_relative
    - runtime_import=@myorg/ws-transport
```

**Recommended setup** — Use Connect-RPC for unary and WS for streaming:
```yaml
plugins:
  # Connect-RPC handles unary RPCs
  - local: protoc-gen-connect-go
    out: gen
    opt: paths=source_relative
  # WS handles streaming RPCs only
  - local: protoc-gen-ws
    out: gen
    opt:
      - paths=source_relative
      - ws_import=github.com/danhtran94/protoc-gen-ws/ws
      - streaming_only=true
  - local: protoc-gen-ws-ts
    out: ts/gen
    opt:
      - paths=source_relative
      - runtime_import=../src
      - streaming_only=true
```

---

## RPC Patterns

### Unary

One request, one response. Simplest pattern — the yamux stream is opened, used, and closed within a single call.

**Proto:**
```protobuf
rpc CreateUser(CreateUserRequest) returns (CreateUserResponse) {}
```

**Sequence:**
```
Client                              Server
  │                                   │
  │── open yamux stream ──────────────│
  │── [Data: method name] ──────────→ │  router.dispatch reads method
  │── [Data: CreateUserRequest] ────→ │  handler receives payload
  │                                   │  handler calls svc.CreateUser()
  │← [Data: CreateUserResponse] ─────│  handler marshals response
  │── stream close ───────────────────│
```

**Go handler:**
```go
func (s *Server) CreateUser(ctx context.Context, req *v1.CreateUserRequest) (*v1.CreateUserResponse, error) {
    u, err := s.ident.CreateUser(ctx, identity.CreateUserInput{
        Email: req.Email, Username: req.Username, Role: user.Role(req.Role),
    })
    if err != nil {
        return nil, err
    }
    return &v1.CreateUserResponse{User: userToProto(u)}, nil
}
```

**TypeScript client:**
```typescript
const session = await YamuxSession.connect("ws://localhost:3000/ws");
const client = new IdentityServiceWSClient(session);
const resp = await client.createUser({ email: "a@b.com", username: "alice", role: "admin" });
console.log(resp.user);
```

### Server Streaming

Client sends one request, server sends multiple responses. The server controls when the stream ends by returning from the handler (which triggers write-side close).

**Proto:**
```protobuf
rpc WatchUsers(WatchUsersRequest) returns (stream UserEvent) {}
```

**Sequence:**
```
Client                              Server
  │── open yamux stream ──────────────│
  │── [Data: method name] ──────────→ │
  │── [Data: WatchUsersRequest] ────→ │  reads initial request
  │                                   │
  │← [Data: UserEvent] ──────────────│  ss.Send(event1)
  │← [Data: UserEvent] ──────────────│  ss.Send(event2)
  │← [Data: UserEvent] ──────────────│  ss.Send(event3)
  │                                   │  handler returns
  │← FIN ────────────────────────────│  stream half-close
  │  (client sees EOF)                │
```

**Go handler:**
```go
func (s *Server) WatchUsers(ctx context.Context, req *v1.WatchUsersRequest, ss *ws.ServerStream[*v1.UserEvent]) error {
    for event := range s.userEvents {
        if err := ss.Send(event); err != nil {
            return err
        }
    }
    return nil
}
```

**TypeScript client (async iteration):**
```typescript
const stream = await client.watchUsers({ role: "admin" });
for await (const event of stream) {
    console.log(event.type, event.user);
}
```

**TypeScript client (push-based for UIs):**
```typescript
const stream = await client.watchUsers({ role: "" });
stream.listen({
    onMessage: (event) => appendToList(event),
    onEnd: () => showBanner("stream ended"),
});
```

### Client Streaming

Client sends multiple requests, server reads them and returns one response at the end. The client signals completion by half-closing its write side, which the server sees as `io.EOF` on `Recv`.

**Proto:**
```protobuf
rpc ImportUsers(stream CreateUserRequest) returns (ImportUsersResponse) {}
```

**Sequence:**
```
Client                              Server
  │── open yamux stream ──────────────│
  │── [Data: method name] ──────────→ │
  │── [Data: CreateUserRequest] ────→ │  cs.Recv() → request 1
  │── [Data: CreateUserRequest] ────→ │  cs.Recv() → request 2
  │── [Data: CreateUserRequest] ────→ │  cs.Recv() → request 3
  │── FIN (half-close) ──────────────│  cs.Recv() → io.EOF
  │                                   │  handler builds response
  │← [Data: ImportUsersResponse] ────│  stream.SendProto(resp)
```

**Go handler:**
```go
func (s *Server) ImportUsers(ctx context.Context, cs *ws.ClientStream[*v1.CreateUserRequest]) (*v1.ImportUsersResponse, error) {
    var imported, failed int32
    for {
        req, err := cs.Recv()
        if err == io.EOF {
            break
        }
        if err != nil {
            return nil, err
        }
        if err := s.processUser(ctx, req); err != nil {
            failed++
        } else {
            imported++
        }
    }
    return &v1.ImportUsersResponse{ImportedCount: imported, FailedCount: failed}, nil
}
```

**TypeScript client:**
```typescript
const stream = await client.importUsers();
await stream.send({ email: "a@b.com", username: "alice", role: "employee" });
await stream.send({ email: "b@c.com", username: "bob", role: "manager" });
const result = await stream.closeAndRecv();
console.log(`Imported: ${result.importedCount}, Failed: ${result.failedCount}`);
```

### Bidirectional Streaming

Both sides send and receive messages independently. The stream stays open until one side closes its write half.

**Proto:**
```protobuf
rpc SyncUsers(stream SyncUsersRequest) returns (stream SyncUsersResponse) {}
```

**Sequence:**
```
Client                              Server
  │── open yamux stream ──────────────│
  │── [Data: method name] ──────────→ │
  │                                   │
  │── [Data: SyncUsersRequest] ─────→ │  bs.Recv()
  │← [Data: SyncUsersResponse] ──────│  bs.Send()
  │── [Data: SyncUsersRequest] ─────→ │  bs.Recv()
  │← [Data: SyncUsersResponse] ──────│  bs.Send()
  │← [Data: SyncUsersResponse] ──────│  bs.Send() (unsolicited)
  │── FIN (half-close) ──────────────│  bs.Recv() → io.EOF
  │← FIN ────────────────────────────│  handler returns
```

**Go handler:**
```go
func (s *Server) SyncUsers(ctx context.Context, bs *ws.BidiStream[*v1.SyncUsersRequest, *v1.SyncUsersResponse]) error {
    for {
        req, err := bs.Recv()
        if err == io.EOF {
            return nil
        }
        if err != nil {
            return err
        }
        // Process and respond
        resp := s.processSync(ctx, req)
        if err := bs.Send(resp); err != nil {
            return err
        }
    }
}
```

**TypeScript client (push-based):**
```typescript
const stream = await client.syncUsers();

// Background reader
stream.listen({
    onMessage: (resp) => {
        if (resp.type === "snapshot") loadUser(resp.user);
        if (resp.type === "ack") confirmAction(resp);
    },
    onEnd: () => console.log("sync ended"),
});

// Send whenever
await stream.send({ type: "subscribe", userId: "user-123" });
await stream.send({ type: "unsubscribe", userId: "user-456" });
stream.close(); // done sending
```

---

## Raw Binary Streaming

The framing protocol is payload-agnostic — protobuf serialization only happens in the typed wrappers (`ServerStream[T]`, `ClientStream[T]`, etc.) and generated code. The underlying `Stream` (Go) and `WSStream` (TypeScript) work with raw `[]byte` / `Uint8Array`, making raw binary transmission a first-class capability with zero overhead.

### When to use raw binary

| Scenario | Recommendation |
|----------|---------------|
| Standard RPC with typed messages | Use protobuf + codegen (normal path) |
| File upload/download | Raw binary via `StreamHandler` |
| Video/audio chunks | Raw binary via `StreamHandler` |
| Custom serialization (JSON, MsgPack, etc.) | Raw binary via `StreamHandler` |
| Protobuf with occasional large blobs | Protobuf `bytes` field (small overhead, keeps codegen) |

### Go server — register raw binary handlers

Use `HandleStream` to register a `StreamHandler` that works directly with `*ws.Stream`. No protobuf, no codegen — just raw bytes through the framing protocol.

**Unary echo (raw binary):**

```go
router.HandleStream("myapp.files/echo", func(ctx context.Context, s *ws.Stream) {
    data, err := s.Recv()
    if err != nil {
        s.SendError("recv: " + err.Error())
        return
    }
    s.Send(data) // echo back unchanged
})
```

**Server streaming (chunked download):**

```go
router.HandleStream("myapp.files/download", func(ctx context.Context, s *ws.Stream) {
    // First frame: file identifier or metadata
    meta, err := s.Recv()
    if err != nil {
        s.SendError(err.Error())
        return
    }

    file, err := os.Open(string(meta))
    if err != nil {
        s.SendError(err.Error())
        return
    }
    defer file.Close()

    buf := make([]byte, 64*1024) // 64KB chunks
    for {
        n, err := file.Read(buf)
        if n > 0 {
            if sendErr := s.Send(buf[:n]); sendErr != nil {
                return // client disconnected
            }
        }
        if err == io.EOF {
            return // handler returns → write-side closes → client sees EOF
        }
        if err != nil {
            s.SendError(err.Error())
            return
        }
    }
})
```

**Client streaming (chunked upload):**

```go
router.HandleStream("myapp.files/upload", func(ctx context.Context, s *ws.Stream) {
    var totalBytes int
    for {
        chunk, err := s.Recv()
        if err == io.EOF {
            break // client finished sending
        }
        if err != nil {
            s.SendError(err.Error())
            return
        }
        totalBytes += len(chunk)
        // Process chunk: write to file, hash, etc.
    }

    // Send summary back
    resp := fmt.Sprintf(`{"bytes":%d}`, totalBytes)
    s.Send([]byte(resp))
})
```

**Bidirectional (real-time transform):**

```go
router.HandleStream("myapp.audio/process", func(ctx context.Context, s *ws.Stream) {
    for {
        chunk, err := s.Recv()
        if err == io.EOF {
            return
        }
        if err != nil {
            s.SendError(err.Error())
            return
        }
        processed := applyFilter(chunk) // transform audio samples
        if err := s.Send(processed); err != nil {
            return
        }
    }
})
```

### TypeScript client — using `openStream` + `WSStream`

Use `openStream(session, method)` to get a raw `WSStream`, then call `send()` and `recv()` directly:

**Unary echo:**

```typescript
import { openStream } from "protoc-gen-ws/ts/src/transport.js";

const ws = await openStream(session, "myapp.files/echo");
await ws.send(new Uint8Array([0xDE, 0xAD, 0xBE, 0xEF]));
const result = await ws.recv(); // Uint8Array
ws.close();
```

**Server streaming (chunked download):**

```typescript
const ws = await openStream(session, "myapp.files/download");

// Send file path as metadata
await ws.send(new TextEncoder().encode("/data/photo.png"));

// Read chunks until EOF
const chunks: Uint8Array[] = [];
try {
    while (true) {
        chunks.push(await ws.recv());
    }
} catch (e) {
    if (!(e instanceof EOF)) throw e;
}

// Reassemble file
const totalSize = chunks.reduce((sum, c) => sum + c.length, 0);
const file = new Uint8Array(totalSize);
let offset = 0;
for (const chunk of chunks) {
    file.set(chunk, offset);
    offset += chunk.length;
}
```

**Client streaming (chunked upload):**

```typescript
const ws = await openStream(session, "myapp.files/upload");

// Stream file in 64KB chunks
const chunkSize = 64 * 1024;
for (let offset = 0; offset < fileBytes.length; offset += chunkSize) {
    await ws.send(fileBytes.subarray(offset, offset + chunkSize));
}

// Half-close to signal upload complete
ws.close();

// Read server's response
const resp = await ws.recv();
console.log(new TextDecoder().decode(resp)); // {"bytes":123456}
```

**Bidirectional:**

```typescript
const ws = await openStream(session, "myapp.audio/process");

// Send audio chunk, get processed chunk back
for (const chunk of audioChunks) {
    await ws.send(chunk);
    const processed = await ws.recv();
    playAudio(processed);
}
ws.close();
```

### Mixing raw binary and protobuf

Raw binary handlers and protobuf-generated handlers coexist on the same `WSRouter` and same `YamuxSession`. They can be used interchangeably within a single session:

```go
// Go: register both on the same router
wsRouter := ws.NewWSRouter()
v1ws.RegisterIdentityServiceWS(wsRouter, identityHandler) // protobuf
wsRouter.HandleStream("myapp.files/upload", uploadHandler) // raw binary
r.Handle("/ws", wsRouter)
```

```typescript
// TypeScript: mix on the same session
const session = await YamuxSession.connect("ws://localhost:3000/ws");

// Protobuf RPC
const client = new IdentityServiceWSClient(session);
await client.createUser({ email: "a@b.com", username: "alice", role: "admin" });

// Raw binary on the same session
const ws = await openStream(session, "myapp.files/upload");
await ws.send(fileBytes);
ws.close();
const resp = await ws.recv();
```

Each call opens a separate yamux stream, so they don't interfere with each other.

### Wire format comparison

Both raw binary and protobuf use the same framing:

```
Raw binary:     [0x00][length LE][raw bytes]
Protobuf:       [0x00][length LE][proto.Marshal(msg)]
Error:          [0x01][length LE][UTF-8 string]
```

The only difference is what's inside the payload. The framing layer doesn't know or care.

---

## Integration Guide

### Defining Services

Add RPC methods to your `.proto` file using standard protobuf streaming annotations:

```protobuf
service IdentityService {
  rpc CreateUser(CreateUserRequest) returns (CreateUserResponse) {}          // unary
  rpc WatchUsers(WatchUsersRequest) returns (stream UserEvent) {}            // server stream
  rpc ImportUsers(stream CreateUserRequest) returns (ImportUsersResponse) {}  // client stream
  rpc SyncUsers(stream SyncUsersRequest) returns (stream SyncUsersResponse) {} // bidi
}
```

Run code generation:
```bash
buf generate
```

### Implementing Handlers

Create a handler struct that implements the generated interface:

```go
type IdentityWSServer struct {
    v1ws.UnimplementedIdentityServiceWSHandler  // forward compat
    ident *identity.Identity
}

func NewIdentityWSServer(ident *identity.Identity) *IdentityWSServer {
    return &IdentityWSServer{ident: ident}
}

// Implement each method from the IdentityServiceWSHandler interface...
func (s *IdentityWSServer) CreateUser(ctx context.Context, req *v1.CreateUserRequest) (*v1.CreateUserResponse, error) {
    // Reuse the same business logic as REST/Connect-RPC handlers
    u, err := s.ident.CreateUser(ctx, identity.CreateUserInput{...})
    // ...
}
```

### Mounting the Router

```go
// Create router and register handlers
wsRouter := ws.NewWSRouter()
v1ws.RegisterIdentityServiceWS(wsRouter, NewIdentityWSServer(ident))

// Mount on a path (coexists with REST + Connect-RPC on same port)
r.Handle("/ws", wsRouter)
```

### TypeScript Client Usage

```typescript
import { YamuxSession } from "protoc-gen-ws/ts/src/yamux.js";
import { IdentityServiceWSClient } from "./gen/v1/identity.ws.js";

// Connect once, reuse for all RPCs
const session = await YamuxSession.connect("ws://localhost:3000/ws");
const client = new IdentityServiceWSClient(session);

// Unary
const { user } = await client.createUser({ email: "a@b.com", username: "alice", role: "admin" });

// Server stream
const events = await client.watchUsers({ role: "" });
for await (const event of events) {
    console.log(event.type, event.user?.username);
}

// Clean up
session.close();
```

---

## Error Handling

Errors propagate through **error frames** (type `0x01`) in the application framing protocol:

| Scenario | Go Server Behavior | TypeScript Client Sees |
|----------|-------------------|----------------------|
| Handler returns `error` | Sends error frame with `err.Error()` | `RemoteError` thrown |
| Handler panics | Sends error frame `"handler panic: ..."` | `RemoteError` thrown |
| Unknown method | Sends error frame `"unknown method: ..."` | `RemoteError` thrown |
| Unmarshal failure | Sends error frame with details | `RemoteError` thrown |
| Remote closes write | yamux FIN | `EOF` thrown on `recv()` |
| Stream reset | yamux RST | `Error("stream reset by remote")` |
| WebSocket closes | Session teardown | All pending reads reject |

**Go `RemoteError`** — returned by `Stream.Recv()` when the remote sends an error frame:
```go
type RemoteError struct {
    Message string
}
```

**TypeScript `RemoteError`** — thrown by `WSStream.recv()`:
```typescript
class RemoteError extends Error {
    constructor(message: string)
}
```

**TypeScript `EOF`** — thrown when the remote half-closes (signals end of stream):
```typescript
class EOF extends Error {
    constructor()  // message = "EOF"
}
```

---

## Testing

### Go Unit Tests (`ws/ws_test.go`)

Tests the core runtime using in-process `net.Pipe()` connections (no real WebSocket needed):

- Frame protocol roundtrip (WriteFrame/ReadFrame)
- Router dispatch for unary and stream handlers
- Error frame propagation
- Unknown method handling
- Panic recovery in handlers
- Concurrent unary calls
- Server streaming with typed `ServerStream`
- Client streaming with typed `ClientStream` and half-close
- Bidirectional streaming with typed `BidiStream`
- Unimplemented handler errors
- **Raw binary**: unary echo, server streaming chunks, client streaming upload with half-close, bidi XOR transform, 1MB large payload through yamux

### TypeScript Unit Tests

- **`bytebuffer.test.ts`** — ByteBuffer accumulation, exact reads, close behavior
- **`stream.test.ts`** — WSStream framing: send/recv data frames, error frames, RemoteError
- **`transport.test.ts`** — ServerStream, ClientStream, BidiStream with mock yamux streams

### TypeScript Integration Tests (`example/ts/src/__tests__/integration.test.ts`)

Full cross-language tests — TypeScript client connects to a real Go server:

- Spawns a Go test server binary via `child_process`
- Tests all 5 RPC methods (2 unary, 1 server stream, 1 client stream, 1 bidi stream)
- Validates correct protobuf serialization across the language boundary
- Tests error frame propagation
- Tests concurrent RPCs on a single WebSocket
- **Raw binary**: unary echo, server streaming download, client streaming upload, bidi XOR transform, 512KB large payload, mixed raw binary + protobuf on same session

Run all tests:
```bash
# Go tests
go test ./ws/ -race

# TypeScript unit tests
cd ts && npm test

# Example integration tests (includes Go server)
cd example/ts && npm test
```

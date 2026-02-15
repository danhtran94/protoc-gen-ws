# protoc-gen-ws

Protobuf-defined RPC services over a single WebSocket connection using [yamux](https://github.com/hashicorp/yamux) multiplexing. Supports unary, server-streaming, client-streaming, and bidirectional-streaming patterns with full type safety in Go and TypeScript.

## ⚠️ Experimental Status

**This project is currently experimental and not recommended for production use.**

- APIs may change without notice
- Limited real-world testing
- Performance characteristics not fully benchmarked
- Error handling and edge cases still being refined

Feedback, issues, and contributions are welcome as we work toward a stable release.

## Why?

Traditional HTTP-based RPC frameworks (gRPC-web, Connect) require:
- One HTTP/2 connection per concurrent stream
- Complex connection pooling and management
- Higher overhead for mobile/constrained environments
- Reconnection storms during network transitions
- **Ops infrastructure complexity** - gRPC-web needs Envoy/proxies for protocol translation and browser compatibility

**protoc-gen-ws** solves this by:

- **Single persistent connection** - One WebSocket carries unlimited concurrent RPCs via yamux multiplexing
- **Lower latency** - No connection setup overhead for each RPC; streams start instantly
- **Better mobile performance** - Fewer connections = less battery drain and better handling of network transitions
- **Simplified architecture** - No connection pools, no head-of-line blocking, straightforward flow control
- **No proxy infrastructure** - WebSockets work natively in browsers and Go; no Envoy, grpc-gateway, or protocol translation needed
- **Full streaming support** - All four RPC patterns work naturally over multiplexed streams
- **Coexistence** - Use alongside Connect/gRPC-web (WebSocket for streaming, HTTP/2 for simple unary calls)

Ideal for:
- Real-time applications with frequent bidirectional communication
- Mobile apps where connection overhead matters
- Long-lived connections with many concurrent operations
- Environments where connection limits are a constraint

## Install

```bash
go tool github.com/danhtran94/protoc-gen-ws/cmd/protoc-gen-ws@latest
go tool github.com/danhtran94/protoc-gen-ws/cmd/protoc-gen-ws-ts@latest
```

Note: `go tool <tool>` uses tool dependencies declared in go.mod (Go 1.21+).

## Usage

### buf.gen.yaml

```yaml
version: v2
inputs:
  - directory: proto
plugins:
  - local: ["go", "tool", "protoc-gen-go"]
    out: gen
    opt: paths=source_relative
  - local: ["go", "tool", "protoc-gen-connect-go"]
    out: gen
    opt: paths=source_relative
  - local: ["go", "tool", "protoc-gen-ws"]
    out: gen
    opt:
      - paths=source_relative
      - ws_import=github.com/danhtran94/protoc-gen-ws/ws
  - remote: buf.build/bufbuild/es:v2.2.3
    out: ts/gen
    opt: target=ts
  - local: ["go", "tool", "protoc-gen-ws-ts"]
    out: ts/gen
    opt:
      - paths=source_relative
      - runtime_import=protoc-gen-ws
```

### Go server

```go
import "github.com/danhtran94/protoc-gen-ws/ws"

router := ws.NewWSRouter()
v1ws.RegisterIdentityServiceWS(router, handler)
http.Handle("/ws", router)
```

### TypeScript client

```typescript
import { YamuxSession } from "protoc-gen-ws/yamux.js";
import { IdentityServiceWSClient } from "./gen/v1/identity.ws.js";

const session = await YamuxSession.connect("ws://localhost:3000/ws");
const client = new IdentityServiceWSClient(session);

// Unary
const resp = await client.createUser({ email: "a@b.com", username: "alice", role: "admin" });

// Server stream
const stream = await client.watchUsers({ role: "" });
for await (const event of stream) {
  console.log(event);
}

session.close();
```

## Configuration

### Plugin options

Both plugins support a `streaming_only` flag to skip unary methods (useful when Connect-RPC handles unary):

```yaml
- local: protoc-gen-ws
  out: gen
  opt:
    - paths=source_relative
    - ws_import=github.com/danhtran94/protoc-gen-ws/ws
    - streaming_only=true
```

### TypeScript runtime import

`protoc-gen-ws-ts` requires `runtime_import` and emits ESM imports ending in `.js`.

Published package (recommended):

```yaml
- local: protoc-gen-ws-ts
  out: ts/gen
  opt:
    - paths=source_relative
    - runtime_import=protoc-gen-ws
```

Local source (only if you manage a resolver alias yourself):

```yaml
- local: protoc-gen-ws-ts
  out: ts/gen
  opt:
    - paths=source_relative
    - runtime_import=../src
```

## Development setup

For local development in this repo, the example project uses a `file:` dependency to the local TS runtime so it behaves like a published package:

- `example/ts/package.json` depends on `protoc-gen-ws: file:../../ts`.
- `npm test` in `example/ts` runs a `pretest` build of the runtime.
- Regenerate stubs after changes to the plugins or proto with `make gen-example`.

## Publishing

### npm

From the `ts/` package directory:

```bash
npm run build
npm publish
```

Notes:
- The package ships `dist/` only. `exports` in `ts/package.json` maps subpath imports like `protoc-gen-ws/yamux.js`.
- Keep `type: module` (ESM) and `.js` import paths for compatibility with generated code.

### JSR

JSR publishes from `ts/` as well. A typical flow:

```bash
npm run build
npx jsr publish
```

Notes:
- JSR expects ESM and types; the build produces `dist/src/*.d.ts` alongside JS.
- If you want a different package name on JSR, set it in `ts/package.json` and re-run `npm run build`.

## Components

| Directory | Description |
|-----------|-------------|
| `ws/` | Go runtime — router, stream, typed stream wrappers |
| `cmd/protoc-gen-ws/` | Go protoc plugin — generates handler interfaces + client |
| `cmd/protoc-gen-ws-ts/` | TS protoc plugin — generates typed client class |
| `ts/` | TypeScript runtime — yamux, framing, transport |
| `example/` | Full working example with integration tests |
| `docs/` | Detailed documentation |

## Documentation

See [docs/ws-streaming.md](docs/ws-streaming.md) for the complete protocol specification, architecture overview, and integration guide.

## Development

```bash
make test          # Run Go + TS tests
make test-go       # Go runtime tests only
make test-ts       # TS unit tests only
make test-example-ts  # Example TS integration tests (regenerates stubs)
make test-all      # Go + TS + example integration tests
make install       # Install both protoc plugins
make gen-example   # Regenerate example code
```

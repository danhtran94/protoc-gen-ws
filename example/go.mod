module github.com/danhtran94/protoc-gen-ws/example

go 1.24.0

require (
	connectrpc.com/connect v1.19.1
	github.com/danhtran94/protoc-gen-ws v0.0.0
	github.com/hashicorp/yamux v0.1.2
	google.golang.org/protobuf v1.36.11
)

require github.com/coder/websocket v1.8.14 // indirect

tool (
	connectrpc.com/connect/cmd/protoc-gen-connect-go
	github.com/danhtran94/protoc-gen-ws/cmd/protoc-gen-ws
	github.com/danhtran94/protoc-gen-ws/cmd/protoc-gen-ws-ts
	google.golang.org/protobuf/cmd/protoc-gen-go
)

replace github.com/danhtran94/protoc-gen-ws => ../

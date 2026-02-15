package main

import (
	"context"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"

	v1 "github.com/danhtran94/protoc-gen-ws/example/gen/v1"
	"github.com/danhtran94/protoc-gen-ws/example/gen/v1/v1ws"
	"github.com/danhtran94/protoc-gen-ws/ws"
)

// Mock handler — implements the generated IdentityServiceWSHandler interface.
type mockIdentityHandler struct {
	v1ws.UnimplementedIdentityServiceWSHandler
}

func (h *mockIdentityHandler) CreateUser(_ context.Context, req *v1.CreateUserRequest) (*v1.CreateUserResponse, error) {
	if req.Email == "error@example.com" {
		return nil, fmt.Errorf("validation failed: email %q is invalid", req.Email)
	}
	return &v1.CreateUserResponse{
		User: &v1.User{
			Id:       "test-id-123",
			Email:    req.Email,
			Username: req.Username,
			Role:     req.Role,
		},
	}, nil
}

func (h *mockIdentityHandler) GetUser(_ context.Context, req *v1.GetUserRequest) (*v1.GetUserResponse, error) {
	return &v1.GetUserResponse{
		User: &v1.User{
			Id:       req.Id,
			Email:    "found@example.com",
			Username: "found-user",
			Role:     "employee",
		},
	}, nil
}

func (h *mockIdentityHandler) WatchUsers(_ context.Context, req *v1.WatchUsersRequest, stream *ws.ServerStream[*v1.UserEvent]) error {
	switch req.Role {
	case "__empty":
		// Return immediately — 0 events, tests empty-stream EOF handling
		return nil
	case "__infinite":
		// Send forever until client closes — tests early-close behavior
		for i := 0; ; i++ {
			if err := stream.Send(&v1.UserEvent{
				Type: "created",
				User: &v1.User{Username: fmt.Sprintf("user-%d", i), Role: "infinite"},
			}); err != nil {
				return err
			}
		}
	default:
		// Normal: send 3 events
		for _, name := range []string{"alice", "bob", "charlie"} {
			if err := stream.Send(&v1.UserEvent{
				Type: "created",
				User: &v1.User{Username: name, Role: req.Role},
			}); err != nil {
				return err
			}
		}
		return nil
	}
}

func (h *mockIdentityHandler) ImportUsers(_ context.Context, stream *ws.ClientStream[*v1.CreateUserRequest]) (*v1.ImportUsersResponse, error) {
	var count int32
	for {
		_, err := stream.Recv()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, err
		}
		count++
	}
	return &v1.ImportUsersResponse{
		ImportedCount: count,
		FailedCount:   0,
	}, nil
}

func (h *mockIdentityHandler) SyncUsers(_ context.Context, stream *ws.BidiStream[*v1.SyncUsersRequest, *v1.SyncUsersResponse]) error {
	for {
		req, err := stream.Recv()
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
		if err := stream.Send(&v1.SyncUsersResponse{
			Type: "ack",
			User: &v1.User{Id: req.UserId},
		}); err != nil {
			return err
		}
	}
}

// registerRawBinaryHandlers adds non-protobuf raw binary stream handlers
// for testing the raw byte transport path (no codegen, no proto).
func registerRawBinaryHandlers(router *ws.WSRouter) {
	// Unary echo: read one raw frame, send it back unchanged
	router.HandleStream("raw.echo", func(ctx context.Context, s *ws.Stream) {
		data, err := s.Recv()
		if err != nil {
			s.SendError("recv: " + err.Error())
			return
		}
		s.Send(data)
	})

	// Server stream: read a 1-byte count, send that many 64-byte chunks
	router.HandleStream("raw.download", func(ctx context.Context, s *ws.Stream) {
		meta, err := s.Recv()
		if err != nil || len(meta) < 1 {
			s.SendError("recv meta: invalid")
			return
		}
		count := int(meta[0])
		for i := range count {
			chunk := make([]byte, 64)
			for j := range chunk {
				chunk[j] = byte((i * 64) + j)
			}
			if err := s.Send(chunk); err != nil {
				return
			}
		}
	})

	// Client stream: accumulate all received bytes, send back total as 4-byte LE
	router.HandleStream("raw.upload", func(ctx context.Context, s *ws.Stream) {
		var total int
		for {
			data, err := s.Recv()
			if err == io.EOF {
				break
			}
			if err != nil {
				s.SendError("recv: " + err.Error())
				return
			}
			total += len(data)
		}
		var resp [4]byte
		resp[0] = byte(total)
		resp[1] = byte(total >> 8)
		resp[2] = byte(total >> 16)
		resp[3] = byte(total >> 24)
		s.Send(resp[:])
	})

	// Bidi: XOR each received chunk with 0xFF and send back
	router.HandleStream("raw.transform", func(ctx context.Context, s *ws.Stream) {
		for {
			data, err := s.Recv()
			if err == io.EOF {
				return
			}
			if err != nil {
				s.SendError("recv: " + err.Error())
				return
			}
			xored := make([]byte, len(data))
			for i, b := range data {
				xored[i] = b ^ 0xFF
			}
			if err := s.Send(xored); err != nil {
				return
			}
		}
	})

	// Large echo: read one raw frame, send it back (tests big payloads)
	router.HandleStream("raw.echo-large", func(ctx context.Context, s *ws.Stream) {
		data, err := s.Recv()
		if err != nil {
			s.SendError("recv: " + err.Error())
			return
		}
		s.Send(data)
	})
}

func main() {
	staticDir := flag.String("static", "", "serve static test files from this directory at /test/")
	flag.Parse()

	router := ws.NewWSRouter()
	v1ws.RegisterIdentityServiceWS(router, &mockIdentityHandler{})
	registerRawBinaryHandlers(router)

	// When -static is set, serve both WS and static files on the same port.
	// WebSocket upgrades go to the router; regular HTTP gets the test page.
	var handler http.Handler = router
	if *staticDir != "" {
		mux := http.NewServeMux()
		mux.Handle("/test/", http.StripPrefix("/test/", http.FileServer(http.Dir(*staticDir))))
		mux.Handle("/", router)
		handler = mux
	}

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		log.Fatalf("listen: %v", err)
	}

	port := ln.Addr().(*net.TCPAddr).Port
	fmt.Printf("READY:%d\n", port)
	os.Stdout.Sync()

	srv := &http.Server{Handler: handler}

	go func() {
		sigCh := make(chan os.Signal, 1)
		signal.Notify(sigCh, syscall.SIGTERM, syscall.SIGINT)
		<-sigCh
		srv.Close()
	}()

	if err := srv.Serve(ln); err != nil && err != http.ErrServerClosed {
		log.Fatalf("serve: %v", err)
	}
}

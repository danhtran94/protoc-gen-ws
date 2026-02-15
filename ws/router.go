package ws

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"sync"

	"github.com/coder/websocket"
	"github.com/hashicorp/yamux"
	"google.golang.org/protobuf/proto"
)

// UnaryHandler handles a single request/response RPC over a yamux stream.
// payload is the raw bytes from the second data frame (typically a serialized protobuf).
type UnaryHandler func(ctx context.Context, payload []byte) (proto.Message, error)

// StreamHandler handles streaming RPCs (server, client, or bidirectional).
// The handler owns the stream lifecycle and should return when done.
type StreamHandler func(ctx context.Context, stream *Stream)

// WSRouter routes incoming yamux streams to registered unary or stream handlers.
type WSRouter struct {
	mu     sync.RWMutex
	unary  map[string]UnaryHandler
	stream map[string]StreamHandler
}

// NewWSRouter creates a new WebSocket router.
func NewWSRouter() *WSRouter {
	return &WSRouter{
		unary:  make(map[string]UnaryHandler),
		stream: make(map[string]StreamHandler),
	}
}

// Handle registers a unary (request/response) handler for the given method name.
func (r *WSRouter) Handle(method string, h UnaryHandler) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.unary[method] = h
}

// HandleStream registers a streaming handler for the given method name.
func (r *WSRouter) HandleStream(method string, h StreamHandler) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.stream[method] = h
}

// ServeHTTP upgrades the HTTP connection to WebSocket, creates a yamux session,
// and dispatches incoming streams to registered handlers.
func (r *WSRouter) ServeHTTP(w http.ResponseWriter, req *http.Request) {
	wsConn, err := websocket.Accept(w, req, &websocket.AcceptOptions{
		InsecureSkipVerify: true, // Allow any origin for dev; tighten in production
	})
	if err != nil {
		log.Printf("ws: accept error: %v", err)
		return
	}

	ctx, cancel := context.WithCancel(req.Context())
	defer cancel()

	// Convert WebSocket to net.Conn for yamux (handles message reassembly)
	nc := websocket.NetConn(ctx, wsConn, websocket.MessageBinary)

	session, err := yamux.Server(nc, yamux.DefaultConfig())
	if err != nil {
		log.Printf("ws: yamux server error: %v", err)
		wsConn.Close(websocket.StatusInternalError, "yamux init failed")
		return
	}
	defer session.Close()

	// Accept loop: one goroutine per incoming yamux stream
	for {
		ys, err := session.AcceptStream()
		if err != nil {
			if ctx.Err() != nil {
				return // context cancelled, clean shutdown
			}
			log.Printf("ws: yamux accept error: %v", err)
			return
		}
		go r.dispatch(ctx, ys)
	}
}

func (r *WSRouter) dispatch(parentCtx context.Context, ys *yamux.Stream) {
	defer ys.Close()

	// First frame = method name
	typ, methodBytes, err := ReadFrame(ys)
	if err != nil {
		log.Printf("ws: read method frame error: %v", err)
		return
	}
	if typ != FrameData {
		WriteFrame(ys, FrameError, []byte("first frame must be data (method name)"))
		return
	}
	method := string(methodBytes)

	r.mu.RLock()
	unaryH, isUnary := r.unary[method]
	streamH, isStream := r.stream[method]
	r.mu.RUnlock()

	ctx, cancel := context.WithCancel(parentCtx)
	defer cancel()

	switch {
	case isUnary:
		r.handleUnary(ctx, ys, unaryH)
	case isStream:
		r.handleStream(ctx, ys, streamH)
	default:
		WriteFrame(ys, FrameError, []byte("unknown method: "+method))
	}
}

func (r *WSRouter) handleUnary(ctx context.Context, ys *yamux.Stream, h UnaryHandler) {
	// Read request payload
	typ, payload, err := ReadFrame(ys)
	if err != nil {
		log.Printf("ws: read unary request error: %v", err)
		return
	}
	if typ != FrameData {
		WriteFrame(ys, FrameError, []byte("expected data frame for request"))
		return
	}

	resp, err := r.safeCallUnary(ctx, payload, h)
	if err != nil {
		WriteFrame(ys, FrameError, []byte(err.Error()))
		return
	}

	data, err := proto.Marshal(resp)
	if err != nil {
		WriteFrame(ys, FrameError, []byte("marshal response: "+err.Error()))
		return
	}
	WriteFrame(ys, FrameData, data)
}

func (r *WSRouter) safeCallUnary(ctx context.Context, payload []byte, h UnaryHandler) (resp proto.Message, err error) {
	defer func() {
		if v := recover(); v != nil {
			err = fmt.Errorf("handler panic: %v", v)
		}
	}()
	return h(ctx, payload)
}

func (r *WSRouter) handleStream(ctx context.Context, ys *yamux.Stream, h StreamHandler) {
	ctx, cancel := context.WithCancel(ctx)
	s := &Stream{
		rwc:    ys,
		cancel: cancel,
	}
	defer cancel()
	defer func() {
		if v := recover(); v != nil {
			log.Printf("ws: stream handler panic: %v", v)
			WriteFrame(ys, FrameError, []byte(fmt.Sprintf("handler panic: %v", v)))
		}
	}()
	h(ctx, s)
}

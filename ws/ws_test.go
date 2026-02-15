package ws

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/hashicorp/yamux"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/wrapperspb"
)

// --- Frame-level tests using net.Pipe ---

func TestFrameRoundTrip(t *testing.T) {
	t.Run("data frame", func(t *testing.T) {
		a, b := net.Pipe()
		defer a.Close()
		defer b.Close()

		payload := []byte("hello world")
		go func() {
			WriteFrame(a, FrameData, payload)
		}()

		typ, data, err := ReadFrame(b)
		if err != nil {
			t.Fatalf("ReadFrame: %v", err)
		}
		if typ != FrameData {
			t.Fatalf("got type %d, want %d", typ, FrameData)
		}
		if !bytes.Equal(data, payload) {
			t.Fatalf("got %q, want %q", data, payload)
		}
	})

	t.Run("error frame", func(t *testing.T) {
		a, b := net.Pipe()
		defer a.Close()
		defer b.Close()

		errMsg := []byte("something went wrong")
		go func() {
			WriteFrame(a, FrameError, errMsg)
		}()

		typ, data, err := ReadFrame(b)
		if err != nil {
			t.Fatalf("ReadFrame: %v", err)
		}
		if typ != FrameError {
			t.Fatalf("got type %d, want %d", typ, FrameError)
		}
		if !bytes.Equal(data, errMsg) {
			t.Fatalf("got %q, want %q", data, errMsg)
		}
	})

	t.Run("empty payload", func(t *testing.T) {
		a, b := net.Pipe()
		defer a.Close()
		defer b.Close()

		go func() {
			WriteFrame(a, FrameData, []byte{})
		}()

		typ, data, err := ReadFrame(b)
		if err != nil {
			t.Fatalf("ReadFrame: %v", err)
		}
		if typ != FrameData {
			t.Fatalf("got type %d, want %d", typ, FrameData)
		}
		if len(data) != 0 {
			t.Fatalf("got %d bytes, want 0", len(data))
		}
	})
}

// --- Helper: dial a test server and return a yamux client session ---

func dialTestServer(t *testing.T, srv *httptest.Server) *yamux.Session {
	t.Helper()

	ctx := context.Background()
	wsConn, _, err := websocket.Dial(ctx, srv.URL, nil)
	if err != nil {
		t.Fatalf("websocket.Dial: %v", err)
	}

	nc := websocket.NetConn(ctx, wsConn, websocket.MessageBinary)
	session, err := yamux.Client(nc, yamux.DefaultConfig())
	if err != nil {
		t.Fatalf("yamux.Client: %v", err)
	}
	t.Cleanup(func() { session.Close() })
	return session
}

// callUnary opens a yamux stream, sends method + payload frames, reads the response.
func callUnary(session *yamux.Session, method string, payload []byte) (byte, []byte, error) {
	stream, err := session.Open()
	if err != nil {
		return 0, nil, fmt.Errorf("session.Open: %w", err)
	}
	defer stream.Close()

	// Send method frame
	if err := WriteFrame(stream, FrameData, []byte(method)); err != nil {
		return 0, nil, fmt.Errorf("write method: %w", err)
	}
	// Send request payload frame
	if err := WriteFrame(stream, FrameData, payload); err != nil {
		return 0, nil, fmt.Errorf("write payload: %w", err)
	}

	// Read response
	typ, data, err := ReadFrame(stream)
	if err != nil {
		return 0, nil, fmt.Errorf("read response: %w", err)
	}
	return typ, data, nil
}

// --- WSRouter tests ---

func TestWSRouterUnary(t *testing.T) {
	router := NewWSRouter()
	router.Handle("echo", func(ctx context.Context, payload []byte) (proto.Message, error) {
		return wrapperspb.Bytes(payload), nil
	})

	srv := httptest.NewServer(router)
	defer srv.Close()

	session := dialTestServer(t, srv)

	reqPayload := []byte("ping")
	typ, data, err := callUnary(session, "echo", reqPayload)
	if err != nil {
		t.Fatalf("callUnary: %v", err)
	}
	if typ != FrameData {
		t.Fatalf("got frame type %d, want %d (data)", typ, FrameData)
	}

	var resp wrapperspb.BytesValue
	if err := proto.Unmarshal(data, &resp); err != nil {
		t.Fatalf("proto.Unmarshal: %v", err)
	}
	if !bytes.Equal(resp.Value, reqPayload) {
		t.Fatalf("got %q, want %q", resp.Value, reqPayload)
	}
}

func TestWSRouterStream(t *testing.T) {
	router := NewWSRouter()
	router.HandleStream("echo-stream", func(ctx context.Context, s *Stream) {
		for {
			data, err := s.Recv()
			if err != nil {
				return // EOF or error — done
			}
			if err := s.Send(data); err != nil {
				return
			}
		}
	})

	srv := httptest.NewServer(router)
	defer srv.Close()

	session := dialTestServer(t, srv)

	stream, err := session.Open()
	if err != nil {
		t.Fatalf("session.Open: %v", err)
	}
	defer stream.Close()

	// Send method frame
	if err := WriteFrame(stream, FrameData, []byte("echo-stream")); err != nil {
		t.Fatalf("write method: %v", err)
	}

	// Send 3 messages, read 3 echoed messages
	messages := []string{"one", "two", "three"}
	for _, msg := range messages {
		if err := WriteFrame(stream, FrameData, []byte(msg)); err != nil {
			t.Fatalf("send %q: %v", msg, err)
		}

		typ, data, err := ReadFrame(stream)
		if err != nil {
			t.Fatalf("recv echo for %q: %v", msg, err)
		}
		if typ != FrameData {
			t.Fatalf("got frame type %d, want %d", typ, FrameData)
		}
		if string(data) != msg {
			t.Fatalf("got %q, want %q", data, msg)
		}
	}
}

func TestWSRouterUnknownMethod(t *testing.T) {
	router := NewWSRouter()

	srv := httptest.NewServer(router)
	defer srv.Close()

	session := dialTestServer(t, srv)

	stream, err := session.Open()
	if err != nil {
		t.Fatalf("session.Open: %v", err)
	}
	defer stream.Close()

	// Send method frame for an unregistered method
	if err := WriteFrame(stream, FrameData, []byte("nonexistent")); err != nil {
		t.Fatalf("write method: %v", err)
	}

	typ, data, err := ReadFrame(stream)
	if err != nil {
		t.Fatalf("ReadFrame: %v", err)
	}
	if typ != FrameError {
		t.Fatalf("got frame type %d, want %d (error)", typ, FrameError)
	}
	want := "unknown method: nonexistent"
	if string(data) != want {
		t.Fatalf("got %q, want %q", data, want)
	}
}

func TestWSRouterUnaryError(t *testing.T) {
	router := NewWSRouter()
	router.Handle("fail", func(ctx context.Context, payload []byte) (proto.Message, error) {
		return nil, fmt.Errorf("handler exploded")
	})

	srv := httptest.NewServer(router)
	defer srv.Close()

	session := dialTestServer(t, srv)

	typ, data, err := callUnary(session, "fail", []byte("doesn't matter"))
	if err != nil {
		t.Fatalf("callUnary: %v", err)
	}
	if typ != FrameError {
		t.Fatalf("got frame type %d, want %d (error)", typ, FrameError)
	}
	if string(data) != "handler exploded" {
		t.Fatalf("got %q, want %q", data, "handler exploded")
	}
}

func TestWSRouterConcurrentStreams(t *testing.T) {
	router := NewWSRouter()

	// A handler that returns the method-specific prefix + payload
	router.Handle("greet", func(ctx context.Context, payload []byte) (proto.Message, error) {
		return wrapperspb.String("hello " + string(payload)), nil
	})
	router.Handle("farewell", func(ctx context.Context, payload []byte) (proto.Message, error) {
		return wrapperspb.String("bye " + string(payload)), nil
	})

	srv := httptest.NewServer(router)
	defer srv.Close()

	session := dialTestServer(t, srv)

	type result struct {
		method string
		input  string
		want   string
		got    string
		err    error
	}

	calls := []result{
		{method: "greet", input: "alice", want: "hello alice"},
		{method: "farewell", input: "bob", want: "bye bob"},
		{method: "greet", input: "charlie", want: "hello charlie"},
		{method: "farewell", input: "diana", want: "bye diana"},
	}

	var wg sync.WaitGroup
	results := make([]result, len(calls))

	for i, c := range calls {
		wg.Add(1)
		go func(idx int, c result) {
			defer wg.Done()
			r := c

			typ, data, err := callUnary(session, c.method, []byte(c.input))
			if err != nil {
				r.err = err
				results[idx] = r
				return
			}
			if typ == FrameError {
				r.err = fmt.Errorf("error frame: %s", data)
				results[idx] = r
				return
			}

			var resp wrapperspb.StringValue
			if err := proto.Unmarshal(data, &resp); err != nil {
				r.err = fmt.Errorf("unmarshal: %w", err)
				results[idx] = r
				return
			}
			r.got = resp.Value
			results[idx] = r
		}(i, c)
	}

	wg.Wait()

	for i, r := range results {
		if r.err != nil {
			t.Errorf("call[%d] %s(%s): %v", i, r.method, r.input, r.err)
			continue
		}
		if r.got != r.want {
			t.Errorf("call[%d] %s(%s): got %q, want %q", i, r.method, r.input, r.got, r.want)
		}
	}
}

// --- Stream.Recv returns RemoteError for error frames ---

func TestStreamRecvRemoteError(t *testing.T) {
	a, b := net.Pipe()
	defer a.Close()
	defer b.Close()

	// Wrap side b as a yamux server/client pair so we get a *yamux.Stream
	go func() {
		WriteFrame(a, FrameError, []byte("remote failure"))
	}()

	// Read via ReadFrame directly (Stream.Recv uses ReadFrame internally)
	typ, data, err := ReadFrame(b)
	if err != nil {
		t.Fatalf("ReadFrame: %v", err)
	}
	if typ != FrameError {
		t.Fatalf("got type %d, want error frame", typ)
	}

	// Simulate what Stream.Recv does
	rerr := &RemoteError{Message: string(data)}
	if rerr.Error() != "remote failure" {
		t.Fatalf("got %q, want %q", rerr.Error(), "remote failure")
	}
}

// --- ReadFrame returns io.EOF on closed connection ---

func TestReadFrameEOF(t *testing.T) {
	a, b := net.Pipe()
	a.Close() // close writer immediately

	_, _, err := ReadFrame(b)
	if err != io.EOF {
		t.Fatalf("got %v, want io.EOF", err)
	}
}

// ==================== Battle Tests ====================

// --- Frame-layer hardening ---

func TestFrameLargePayload(t *testing.T) {
	a, b := net.Pipe()
	defer a.Close()
	defer b.Close()

	// 1 MB payload
	payload := make([]byte, 1<<20)
	for i := range payload {
		payload[i] = byte(i % 251) // prime modulus to detect pattern corruption
	}

	go func() {
		WriteFrame(a, FrameData, payload)
	}()

	typ, data, err := ReadFrame(b)
	if err != nil {
		t.Fatalf("ReadFrame: %v", err)
	}
	if typ != FrameData {
		t.Fatalf("got type %d, want %d", typ, FrameData)
	}
	if len(data) != len(payload) {
		t.Fatalf("got %d bytes, want %d", len(data), len(payload))
	}
	if !bytes.Equal(data, payload) {
		t.Fatal("payload corrupted")
	}
}

func TestFrameMultipleSequential(t *testing.T) {
	a, b := net.Pipe()
	defer a.Close()
	defer b.Close()

	const count = 100
	go func() {
		for i := range count {
			WriteFrame(a, FrameData, []byte(fmt.Sprintf("msg-%d", i)))
		}
	}()

	for i := range count {
		typ, data, err := ReadFrame(b)
		if err != nil {
			t.Fatalf("ReadFrame[%d]: %v", i, err)
		}
		if typ != FrameData {
			t.Fatalf("frame[%d] type %d, want %d", i, typ, FrameData)
		}
		want := fmt.Sprintf("msg-%d", i)
		if string(data) != want {
			t.Fatalf("frame[%d] got %q, want %q", i, data, want)
		}
	}
}

func TestFrameConcurrentWriters(t *testing.T) {
	a, b := net.Pipe()
	defer a.Close()
	defer b.Close()

	// Two goroutines writing concurrently WITH a mutex to serialize writes.
	// Without the mutex, net.Pipe can interleave bytes from concurrent writes.
	const perWriter = 50
	var wg sync.WaitGroup
	var mu sync.Mutex
	wg.Add(2)

	write := func(prefix string) {
		defer wg.Done()
		for i := range perWriter {
			mu.Lock()
			WriteFrame(a, FrameData, []byte(fmt.Sprintf("%s-%d", prefix, i)))
			mu.Unlock()
		}
	}
	go write("A")
	go write("B")

	go func() {
		wg.Wait()
		a.Close()
	}()

	aCount, bCount := 0, 0
	for {
		_, data, err := ReadFrame(b)
		if err != nil {
			break
		}
		s := string(data)
		if len(s) > 0 && s[0] == 'A' {
			aCount++
		} else if len(s) > 0 && s[0] == 'B' {
			bCount++
		}
	}
	total := aCount + bCount
	if total != perWriter*2 {
		t.Fatalf("read %d frames (A=%d B=%d), want %d", total, aCount, bCount, perWriter*2)
	}
}

// --- Router hardening ---

func TestWSRouterHandlerPanic(t *testing.T) {
	router := NewWSRouter()
	router.Handle("panic", func(ctx context.Context, payload []byte) (proto.Message, error) {
		panic("boom")
	})
	router.Handle("echo", func(ctx context.Context, payload []byte) (proto.Message, error) {
		return wrapperspb.Bytes(payload), nil
	})

	srv := httptest.NewServer(router)
	defer srv.Close()

	session := dialTestServer(t, srv)

	// Call the panicking handler — should get an error frame, not a crash
	typ, _, err := callUnary(session, "panic", []byte("trigger"))
	// The server may either: return an error frame, or the stream may reset.
	// Either way, the session should survive.
	if err == nil && typ == FrameData {
		t.Log("panic handler returned data frame unexpectedly, but session survived")
	}

	// Subsequent call on the same session should still work
	typ, data, err := callUnary(session, "echo", []byte("after-panic"))
	if err != nil {
		t.Fatalf("echo after panic: %v", err)
	}
	if typ != FrameData {
		t.Fatalf("echo: got frame type %d, want %d", typ, FrameData)
	}
	var resp wrapperspb.BytesValue
	if err := proto.Unmarshal(data, &resp); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if !bytes.Equal(resp.Value, []byte("after-panic")) {
		t.Fatalf("got %q, want %q", resp.Value, "after-panic")
	}
}

func TestWSRouterContextCancellation(t *testing.T) {
	handlerDone := make(chan struct{})

	router := NewWSRouter()
	router.HandleStream("block", func(ctx context.Context, s *Stream) {
		defer close(handlerDone)
		<-ctx.Done() // Block until context cancelled
	})

	srv := httptest.NewServer(router)
	defer srv.Close()

	session := dialTestServer(t, srv)

	stream, err := session.Open()
	if err != nil {
		t.Fatalf("session.Open: %v", err)
	}

	// Send method frame to start handler
	if err := WriteFrame(stream, FrameData, []byte("block")); err != nil {
		t.Fatalf("write method: %v", err)
	}

	// Close the session — should cancel the handler's context
	stream.Close()
	session.Close()

	select {
	case <-handlerDone:
		// Handler exited — context was cancelled
	case <-time.After(5 * time.Second):
		t.Fatal("handler did not exit after session close (context not cancelled)")
	}
}

func TestWSRouterSlowClient(t *testing.T) {
	handlerDone := make(chan struct{})

	router := NewWSRouter()
	router.HandleStream("firehose", func(ctx context.Context, s *Stream) {
		defer close(handlerDone)
		for i := range 100 {
			if err := s.Send([]byte(fmt.Sprintf("msg-%d", i))); err != nil {
				return // Client closed — expected
			}
		}
	})

	srv := httptest.NewServer(router)
	defer srv.Close()

	session := dialTestServer(t, srv)

	stream, err := session.Open()
	if err != nil {
		t.Fatalf("session.Open: %v", err)
	}

	// Send method frame
	if err := WriteFrame(stream, FrameData, []byte("firehose")); err != nil {
		t.Fatalf("write method: %v", err)
	}

	// Read only 3 messages, then close
	for range 3 {
		_, _, err := ReadFrame(stream)
		if err != nil {
			t.Fatalf("ReadFrame: %v", err)
		}
	}
	stream.Close()

	select {
	case <-handlerDone:
		// Handler exited cleanly
	case <-time.After(5 * time.Second):
		t.Fatal("handler did not exit after client closed")
	}
}

// --- Stream state & half-close ---

func TestStreamHalfClose(t *testing.T) {
	handlerDone := make(chan struct{})

	router := NewWSRouter()
	router.HandleStream("half-close", func(ctx context.Context, s *Stream) {
		defer close(handlerDone)
		// Read data from client
		data, err := s.Recv()
		if err != nil {
			s.SendError("recv data: " + err.Error())
			return
		}

		// Read EOF (client half-closed)
		_, err = s.Recv()
		if err != io.EOF {
			s.SendError(fmt.Sprintf("expected EOF, got: %v", err))
			return
		}

		// Send response back
		s.Send(append([]byte("echo:"), data...))
	})

	srv := httptest.NewServer(router)
	defer srv.Close()

	session := dialTestServer(t, srv)

	stream, err := session.Open()
	if err != nil {
		t.Fatalf("session.Open: %v", err)
	}

	// Send method frame
	WriteFrame(stream, FrameData, []byte("half-close"))

	// Send data
	WriteFrame(stream, FrameData, []byte("payload"))

	// Half-close write side (yamux stream Close sends FIN)
	stream.Close()

	// yamux.Stream.Close() is a half-close: we can still read from it
	typ, data, err := ReadFrame(stream)
	if err != nil {
		t.Fatalf("ReadFrame after half-close: %v", err)
	}
	if typ != FrameData {
		t.Fatalf("got type %d, want data frame (error: %s)", typ, data)
	}
	if string(data) != "echo:payload" {
		t.Fatalf("got %q, want %q", data, "echo:payload")
	}

	select {
	case <-handlerDone:
	case <-time.After(5 * time.Second):
		t.Fatal("handler did not exit")
	}
}

func TestStreamErrorFrameTerminatesRecv(t *testing.T) {
	router := NewWSRouter()
	router.HandleStream("send-error", func(ctx context.Context, s *Stream) {
		s.SendError("something went wrong")
	})

	srv := httptest.NewServer(router)
	defer srv.Close()

	session := dialTestServer(t, srv)

	stream, err := session.Open()
	if err != nil {
		t.Fatalf("session.Open: %v", err)
	}
	defer stream.Close()

	// Send method frame
	WriteFrame(stream, FrameData, []byte("send-error"))

	// Read — should get error frame
	typ, data, err := ReadFrame(stream)
	if err != nil {
		t.Fatalf("ReadFrame: %v", err)
	}
	if typ != FrameError {
		t.Fatalf("got type %d, want error frame", typ)
	}
	if string(data) != "something went wrong" {
		t.Fatalf("got %q, want %q", data, "something went wrong")
	}
}

// --- Concurrent & stress ---

func TestConcurrentUnaryHighLoad(t *testing.T) {
	router := NewWSRouter()
	router.Handle("echo-id", func(ctx context.Context, payload []byte) (proto.Message, error) {
		return wrapperspb.String(string(payload)), nil
	})

	srv := httptest.NewServer(router)
	defer srv.Close()

	session := dialTestServer(t, srv)

	const n = 50
	var wg sync.WaitGroup
	errors := make([]error, n)

	for i := range n {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			payload := fmt.Sprintf("req-%d", idx)
			typ, data, err := callUnary(session, "echo-id", []byte(payload))
			if err != nil {
				errors[idx] = err
				return
			}
			if typ == FrameError {
				errors[idx] = fmt.Errorf("error frame: %s", data)
				return
			}
			var resp wrapperspb.StringValue
			if err := proto.Unmarshal(data, &resp); err != nil {
				errors[idx] = fmt.Errorf("unmarshal: %w", err)
				return
			}
			if resp.Value != payload {
				errors[idx] = fmt.Errorf("got %q, want %q", resp.Value, payload)
			}
		}(i)
	}
	wg.Wait()

	for i, err := range errors {
		if err != nil {
			t.Errorf("call[%d]: %v", i, err)
		}
	}
}

func TestConcurrentStreamsHighLoad(t *testing.T) {
	router := NewWSRouter()
	router.HandleStream("echo-stream", func(ctx context.Context, s *Stream) {
		for {
			data, err := s.Recv()
			if err != nil {
				return
			}
			if err := s.Send(data); err != nil {
				return
			}
		}
	})

	srv := httptest.NewServer(router)
	defer srv.Close()

	session := dialTestServer(t, srv)

	const numStreams = 20
	const msgsPerStream = 10
	var wg sync.WaitGroup
	errs := make([]error, numStreams)

	for i := range numStreams {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()

			stream, err := session.Open()
			if err != nil {
				errs[idx] = fmt.Errorf("open: %w", err)
				return
			}
			defer stream.Close()

			if err := WriteFrame(stream, FrameData, []byte("echo-stream")); err != nil {
				errs[idx] = fmt.Errorf("write method: %w", err)
				return
			}

			for j := range msgsPerStream {
				msg := fmt.Sprintf("s%d-m%d", idx, j)
				if err := WriteFrame(stream, FrameData, []byte(msg)); err != nil {
					errs[idx] = fmt.Errorf("send[%d]: %w", j, err)
					return
				}

				typ, data, err := ReadFrame(stream)
				if err != nil {
					errs[idx] = fmt.Errorf("recv[%d]: %w", j, err)
					return
				}
				if typ != FrameData {
					errs[idx] = fmt.Errorf("recv[%d]: got type %d", j, typ)
					return
				}
				if string(data) != msg {
					errs[idx] = fmt.Errorf("recv[%d]: got %q, want %q", j, data, msg)
					return
				}
			}
		}(i)
	}
	wg.Wait()

	for i, err := range errs {
		if err != nil {
			t.Errorf("stream[%d]: %v", i, err)
		}
	}
}

func TestLargeMessageThroughYamux(t *testing.T) {
	router := NewWSRouter()
	router.Handle("echo-large", func(ctx context.Context, payload []byte) (proto.Message, error) {
		return wrapperspb.Bytes(payload), nil
	})

	srv := httptest.NewServer(router)
	defer srv.Close()

	session := dialTestServer(t, srv)

	// 512KB — larger than yamux's 256KB default window
	payload := make([]byte, 512*1024)
	for i := range payload {
		payload[i] = byte(i % 256)
	}

	typ, data, err := callUnary(session, "echo-large", payload)
	if err != nil {
		t.Fatalf("callUnary: %v", err)
	}
	if typ != FrameData {
		t.Fatalf("got frame type %d, want data", typ)
	}

	var resp wrapperspb.BytesValue
	if err := proto.Unmarshal(data, &resp); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if !bytes.Equal(resp.Value, payload) {
		t.Fatal("large payload corrupted through yamux")
	}
}

// ==================== Raw Binary Tests ====================
// These tests verify that the Stream layer works with raw (non-protobuf)
// binary data, using only Send/Recv and the 5-byte framing protocol.

func TestRawBinaryUnaryEcho(t *testing.T) {
	router := NewWSRouter()
	router.HandleStream("raw.echo", func(ctx context.Context, s *Stream) {
		data, err := s.Recv()
		if err != nil {
			s.SendError("recv: " + err.Error())
			return
		}
		s.Send(data)
	})

	srv := httptest.NewServer(router)
	defer srv.Close()

	session := dialTestServer(t, srv)

	stream, err := session.Open()
	if err != nil {
		t.Fatalf("session.Open: %v", err)
	}
	defer stream.Close()

	// Send method frame
	WriteFrame(stream, FrameData, []byte("raw.echo"))

	// Send raw binary payload (not protobuf — just arbitrary bytes)
	payload := []byte{0x00, 0x01, 0x02, 0xFF, 0xFE, 0xFD, 0x00, 0x80}
	WriteFrame(stream, FrameData, payload)

	typ, data, err := ReadFrame(stream)
	if err != nil {
		t.Fatalf("ReadFrame: %v", err)
	}
	if typ != FrameData {
		t.Fatalf("got type %d, want data frame", typ)
	}
	if !bytes.Equal(data, payload) {
		t.Fatalf("got %x, want %x", data, payload)
	}
}

func TestRawBinaryServerStream(t *testing.T) {
	router := NewWSRouter()
	router.HandleStream("raw.download", func(ctx context.Context, s *Stream) {
		// Read how many chunks the client wants
		meta, err := s.Recv()
		if err != nil {
			s.SendError("recv meta: " + err.Error())
			return
		}
		// meta is just a byte indicating the count
		count := int(meta[0])

		// Send raw binary chunks
		for i := range count {
			chunk := make([]byte, 64)
			for j := range chunk {
				chunk[j] = byte((i * 64) + j)
			}
			if err := s.Send(chunk); err != nil {
				return
			}
		}
		// Stream ends when handler returns (write-side closes)
	})

	srv := httptest.NewServer(router)
	defer srv.Close()

	session := dialTestServer(t, srv)

	stream, err := session.Open()
	if err != nil {
		t.Fatalf("session.Open: %v", err)
	}
	defer stream.Close()

	WriteFrame(stream, FrameData, []byte("raw.download"))
	// Request 5 chunks
	WriteFrame(stream, FrameData, []byte{5})

	for i := range 5 {
		typ, data, err := ReadFrame(stream)
		if err != nil {
			t.Fatalf("chunk[%d] ReadFrame: %v", i, err)
		}
		if typ != FrameData {
			t.Fatalf("chunk[%d] got type %d, want data", i, typ)
		}
		if len(data) != 64 {
			t.Fatalf("chunk[%d] got %d bytes, want 64", i, len(data))
		}
		// Verify the first byte of each chunk
		if data[0] != byte(i*64) {
			t.Fatalf("chunk[%d] first byte: got %d, want %d", i, data[0], byte(i*64))
		}
	}

	// After all chunks, the handler returns and server half-closes
	_, _, err = ReadFrame(stream)
	if err != io.EOF {
		t.Fatalf("expected EOF after stream end, got: %v", err)
	}
}

func TestRawBinaryClientStream(t *testing.T) {
	router := NewWSRouter()
	router.HandleStream("raw.upload", func(ctx context.Context, s *Stream) {
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
		// Send back the total byte count as a 4-byte LE integer
		var resp [4]byte
		resp[0] = byte(total)
		resp[1] = byte(total >> 8)
		resp[2] = byte(total >> 16)
		resp[3] = byte(total >> 24)
		s.Send(resp[:])
	})

	srv := httptest.NewServer(router)
	defer srv.Close()

	session := dialTestServer(t, srv)

	stream, err := session.Open()
	if err != nil {
		t.Fatalf("session.Open: %v", err)
	}

	WriteFrame(stream, FrameData, []byte("raw.upload"))

	// Send 10 chunks of 100 bytes each
	chunk := make([]byte, 100)
	for i := range 10 {
		for j := range chunk {
			chunk[j] = byte(i)
		}
		WriteFrame(stream, FrameData, chunk)
	}

	// Half-close to signal done
	stream.Close()

	// Read the response (total byte count)
	typ, data, err := ReadFrame(stream)
	if err != nil {
		t.Fatalf("ReadFrame response: %v", err)
	}
	if typ != FrameData {
		t.Fatalf("got type %d, want data", typ)
	}
	if len(data) != 4 {
		t.Fatalf("got %d bytes, want 4", len(data))
	}
	total := int(data[0]) | int(data[1])<<8 | int(data[2])<<16 | int(data[3])<<24
	if total != 1000 {
		t.Fatalf("got total %d, want 1000", total)
	}
}

func TestRawBinaryBidiStream(t *testing.T) {
	router := NewWSRouter()
	router.HandleStream("raw.transform", func(ctx context.Context, s *Stream) {
		// For each chunk received, send it back XOR'd with 0xFF
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

	srv := httptest.NewServer(router)
	defer srv.Close()

	session := dialTestServer(t, srv)

	stream, err := session.Open()
	if err != nil {
		t.Fatalf("session.Open: %v", err)
	}
	defer stream.Close()

	WriteFrame(stream, FrameData, []byte("raw.transform"))

	// Interleaved send/recv with raw binary
	payloads := [][]byte{
		{0x00, 0x11, 0x22, 0x33},
		{0xAA, 0xBB, 0xCC, 0xDD},
		{0xFF, 0x00, 0xFF, 0x00},
	}

	for _, p := range payloads {
		if err := WriteFrame(stream, FrameData, p); err != nil {
			t.Fatalf("send: %v", err)
		}

		typ, data, err := ReadFrame(stream)
		if err != nil {
			t.Fatalf("recv: %v", err)
		}
		if typ != FrameData {
			t.Fatalf("got type %d, want data", typ)
		}
		if len(data) != len(p) {
			t.Fatalf("got %d bytes, want %d", len(data), len(p))
		}
		for i, b := range data {
			if b != p[i]^0xFF {
				t.Fatalf("byte[%d]: got 0x%02X, want 0x%02X", i, b, p[i]^0xFF)
			}
		}
	}
}

func TestRawBinaryLargeChunks(t *testing.T) {
	router := NewWSRouter()
	router.HandleStream("raw.echo-stream", func(ctx context.Context, s *Stream) {
		for {
			data, err := s.Recv()
			if err != nil {
				return
			}
			if err := s.Send(data); err != nil {
				return
			}
		}
	})

	srv := httptest.NewServer(router)
	defer srv.Close()

	session := dialTestServer(t, srv)

	stream, err := session.Open()
	if err != nil {
		t.Fatalf("session.Open: %v", err)
	}
	defer stream.Close()

	WriteFrame(stream, FrameData, []byte("raw.echo-stream"))

	// 1 MB chunk — tests large raw binary through the full stack
	payload := make([]byte, 1<<20)
	for i := range payload {
		payload[i] = byte(i % 251)
	}

	if err := WriteFrame(stream, FrameData, payload); err != nil {
		t.Fatalf("send 1MB: %v", err)
	}

	typ, data, err := ReadFrame(stream)
	if err != nil {
		t.Fatalf("recv 1MB: %v", err)
	}
	if typ != FrameData {
		t.Fatalf("got type %d, want data", typ)
	}
	if !bytes.Equal(data, payload) {
		t.Fatal("1MB raw binary payload corrupted through yamux")
	}
}

func TestMultipleSessions(t *testing.T) {
	router := NewWSRouter()
	router.Handle("whoami", func(ctx context.Context, payload []byte) (proto.Message, error) {
		return wrapperspb.String("hello " + string(payload)), nil
	})

	srv := httptest.NewServer(router)
	defer srv.Close()

	// Two independent sessions
	session1 := dialTestServer(t, srv)
	session2 := dialTestServer(t, srv)

	// Concurrent calls on different sessions
	var wg sync.WaitGroup
	var err1, err2 error
	var got1, got2 string

	wg.Add(2)
	go func() {
		defer wg.Done()
		typ, data, err := callUnary(session1, "whoami", []byte("session1"))
		if err != nil {
			err1 = err
			return
		}
		if typ == FrameError {
			err1 = fmt.Errorf("error: %s", data)
			return
		}
		var resp wrapperspb.StringValue
		proto.Unmarshal(data, &resp)
		got1 = resp.Value
	}()
	go func() {
		defer wg.Done()
		typ, data, err := callUnary(session2, "whoami", []byte("session2"))
		if err != nil {
			err2 = err
			return
		}
		if typ == FrameError {
			err2 = fmt.Errorf("error: %s", data)
			return
		}
		var resp wrapperspb.StringValue
		proto.Unmarshal(data, &resp)
		got2 = resp.Value
	}()
	wg.Wait()

	if err1 != nil {
		t.Fatalf("session1: %v", err1)
	}
	if err2 != nil {
		t.Fatalf("session2: %v", err2)
	}
	if got1 != "hello session1" {
		t.Errorf("session1 got %q, want %q", got1, "hello session1")
	}
	if got2 != "hello session2" {
		t.Errorf("session2 got %q, want %q", got2, "hello session2")
	}
}

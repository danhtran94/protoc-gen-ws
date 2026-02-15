package ws

import (
	"context"
	"fmt"

	"github.com/hashicorp/yamux"
	"google.golang.org/protobuf/proto"
)

// CallUnary opens a yamux stream, sends method + payload frames, and reads the response.
func CallUnary(session *yamux.Session, method string, req proto.Message) ([]byte, error) {
	stream, err := session.Open()
	if err != nil {
		return nil, fmt.Errorf("session.Open: %w", err)
	}
	defer stream.Close()

	// Send method frame
	if err := WriteFrame(stream, FrameData, []byte(method)); err != nil {
		return nil, fmt.Errorf("write method: %w", err)
	}

	// Marshal and send request payload
	payload, err := proto.Marshal(req)
	if err != nil {
		return nil, fmt.Errorf("marshal request: %w", err)
	}
	if err := WriteFrame(stream, FrameData, payload); err != nil {
		return nil, fmt.Errorf("write payload: %w", err)
	}

	// Read response
	typ, data, err := ReadFrame(stream)
	if err != nil {
		return nil, fmt.Errorf("read response: %w", err)
	}
	if typ == FrameError {
		return nil, &RemoteError{Message: string(data)}
	}
	return data, nil
}

// OpenStream opens a yamux stream and sends the method frame, returning a typed Stream
// ready for bidirectional communication.
func OpenStream(ctx context.Context, session *yamux.Session, method string) (*Stream, error) {
	ys, err := session.Open()
	if err != nil {
		return nil, fmt.Errorf("session.Open: %w", err)
	}

	// Send method frame
	if err := WriteFrame(ys, FrameData, []byte(method)); err != nil {
		ys.Close()
		return nil, fmt.Errorf("write method: %w", err)
	}

	ctx, cancel := context.WithCancel(ctx)
	_ = ctx // context available for future use (e.g. cancellation propagation)
	return &Stream{rwc: ys, cancel: cancel}, nil
}

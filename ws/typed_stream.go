package ws

import (
	"google.golang.org/protobuf/proto"
)

// --- Server-side typed streams ---

// ServerStream is a server-side send-only typed stream.
type ServerStream[T proto.Message] struct {
	raw *Stream
}

// NewServerStream wraps a raw stream for typed sending.
func NewServerStream[T proto.Message](raw *Stream) *ServerStream[T] {
	return &ServerStream[T]{raw: raw}
}

// Send marshals and sends a typed message.
func (s *ServerStream[T]) Send(msg T) error {
	return s.raw.SendProto(msg)
}

// Close half-closes the write side of the stream.
func (s *ServerStream[T]) Close() error {
	return s.raw.Close()
}

// ClientStream is a server-side receive-only typed stream.
type ClientStream[T proto.Message] struct {
	raw    *Stream
	newMsg func() T
}

// NewClientStream wraps a raw stream for typed receiving.
func NewClientStream[T proto.Message](raw *Stream, newMsg func() T) *ClientStream[T] {
	return &ClientStream[T]{raw: raw, newMsg: newMsg}
}

// Recv reads and unmarshals the next typed message.
func (s *ClientStream[T]) Recv() (T, error) {
	data, err := s.raw.Recv()
	if err != nil {
		var zero T
		return zero, err
	}
	msg := s.newMsg()
	if err := proto.Unmarshal(data, msg); err != nil {
		var zero T
		return zero, err
	}
	return msg, nil
}

// BidiStream is a server-side bidirectional typed stream.
type BidiStream[Req, Res proto.Message] struct {
	raw    *Stream
	newReq func() Req
}

// NewBidiStream wraps a raw stream for typed bidirectional communication.
func NewBidiStream[Req, Res proto.Message](raw *Stream, newReq func() Req) *BidiStream[Req, Res] {
	return &BidiStream[Req, Res]{raw: raw, newReq: newReq}
}

// Recv reads and unmarshals the next typed request message.
func (s *BidiStream[Req, Res]) Recv() (Req, error) {
	data, err := s.raw.Recv()
	if err != nil {
		var zero Req
		return zero, err
	}
	msg := s.newReq()
	if err := proto.Unmarshal(data, msg); err != nil {
		var zero Req
		return zero, err
	}
	return msg, nil
}

// Send marshals and sends a typed response message.
func (s *BidiStream[Req, Res]) Send(msg Res) error {
	return s.raw.SendProto(msg)
}

// Close half-closes the write side of the stream.
func (s *BidiStream[Req, Res]) Close() error {
	return s.raw.Close()
}

// --- Client-side typed streams ---

// ServerStreamClient is a client-side receive-only typed stream.
type ServerStreamClient[T proto.Message] struct {
	raw    *Stream
	newMsg func() T
}

// NewServerStreamClient wraps a raw stream for typed receiving on the client side.
func NewServerStreamClient[T proto.Message](raw *Stream, newMsg func() T) *ServerStreamClient[T] {
	return &ServerStreamClient[T]{raw: raw, newMsg: newMsg}
}

// Recv reads and unmarshals the next typed message.
func (s *ServerStreamClient[T]) Recv() (T, error) {
	data, err := s.raw.Recv()
	if err != nil {
		var zero T
		return zero, err
	}
	msg := s.newMsg()
	if err := proto.Unmarshal(data, msg); err != nil {
		var zero T
		return zero, err
	}
	return msg, nil
}

// Close half-closes the client side of the stream.
func (s *ServerStreamClient[T]) Close() error {
	return s.raw.Close()
}

// ClientStreamClient is a client-side send stream that receives one response at close.
type ClientStreamClient[Req, Res proto.Message] struct {
	raw    *Stream
	newRes func() Res
}

// NewClientStreamClient wraps a raw stream for typed sending on the client side.
func NewClientStreamClient[Req, Res proto.Message](raw *Stream, newRes func() Res) *ClientStreamClient[Req, Res] {
	return &ClientStreamClient[Req, Res]{raw: raw, newRes: newRes}
}

// Send marshals and sends a typed request message.
func (s *ClientStreamClient[Req, Res]) Send(msg Req) error {
	return s.raw.SendProto(msg)
}

// CloseAndRecv half-closes the stream and reads the final typed response.
func (s *ClientStreamClient[Req, Res]) CloseAndRecv() (Res, error) {
	if err := s.raw.Close(); err != nil {
		var zero Res
		return zero, err
	}
	data, err := s.raw.Recv()
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

// BidiStreamClient is a client-side bidirectional typed stream.
type BidiStreamClient[Req, Res proto.Message] struct {
	raw    *Stream
	newRes func() Res
}

// NewBidiStreamClient wraps a raw stream for typed bidirectional communication on the client side.
func NewBidiStreamClient[Req, Res proto.Message](raw *Stream, newRes func() Res) *BidiStreamClient[Req, Res] {
	return &BidiStreamClient[Req, Res]{raw: raw, newRes: newRes}
}

// Send marshals and sends a typed request message.
func (s *BidiStreamClient[Req, Res]) Send(msg Req) error {
	return s.raw.SendProto(msg)
}

// Recv reads and unmarshals the next typed response message.
func (s *BidiStreamClient[Req, Res]) Recv() (Res, error) {
	data, err := s.raw.Recv()
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

// Close half-closes the client side of the stream.
func (s *BidiStreamClient[Req, Res]) Close() error {
	return s.raw.Close()
}

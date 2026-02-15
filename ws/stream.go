package ws

import (
	"encoding/binary"
	"io"

	"google.golang.org/protobuf/proto"
)

// Frame type constants.
const (
	FrameData  byte = 0x00
	FrameError byte = 0x01
)

// halfCloser is an io.ReadWriteCloser that supports half-close.
// yamux streams implement this: Close() only closes the write side,
// allowing reads to continue until the remote side also closes.
type halfCloser interface {
	io.ReadWriteCloser
}

// Stream wraps a yamux stream with framed Send/Recv for streaming RPCs.
// The underlying connection must support half-close semantics (Close stops
// writes but allows reads to continue), which yamux streams provide.
type Stream struct {
	rwc    halfCloser
	cancel func()
}

// Recv reads the next data frame payload from the stream.
// Returns io.EOF when the remote side closes its write half.
func (s *Stream) Recv() ([]byte, error) {
	typ, data, err := ReadFrame(s.rwc)
	if err != nil {
		return nil, err
	}
	if typ == FrameError {
		return nil, &RemoteError{Message: string(data)}
	}
	return data, nil
}

// Send writes a data frame with the given raw bytes.
func (s *Stream) Send(data []byte) error {
	return WriteFrame(s.rwc, FrameData, data)
}

// SendProto marshals a protobuf message and sends it as a data frame.
func (s *Stream) SendProto(msg proto.Message) error {
	data, err := proto.Marshal(msg)
	if err != nil {
		return err
	}
	return s.Send(data)
}

// SendError writes an error frame with the given message.
func (s *Stream) SendError(msg string) error {
	return WriteFrame(s.rwc, FrameError, []byte(msg))
}

// Close half-closes the write side of the stream. The remote side will see
// io.EOF on their next Recv, but this side can still Recv until the remote
// also closes. This relies on yamux's half-close semantics.
func (s *Stream) Close() error {
	return s.rwc.Close()
}

// RemoteError is returned by Recv when the remote side sends an error frame.
type RemoteError struct {
	Message string
}

func (e *RemoteError) Error() string {
	return e.Message
}

// WriteFrame writes a framed message: [1 byte type][4 bytes LE length][payload].
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

// ReadFrame reads a framed message: [1 byte type][4 bytes LE length][payload].
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

import { ByteBuffer } from "protoc-gen-ws/bytebuffer.js";
import { EOF } from "protoc-gen-ws/yamux.js";

/**
 * Mock YamuxStream — bidirectional in-memory pipe for testing.
 * Pairs two ByteBuffers: write on one side appears as readExact on the other.
 */
export class MockYamuxStream {
  readonly id = 1;
  private writeBuf: ByteBuffer;
  private readBuf: ByteBuffer;
  private writeClosed = false;

  constructor(writeBuf: ByteBuffer, readBuf: ByteBuffer) {
    this.writeBuf = writeBuf;
    this.readBuf = readBuf;
  }

  async write(data: Uint8Array): Promise<void> {
    if (this.writeClosed) throw new Error("stream write-closed");
    this.writeBuf.push(data);
  }

  async readExact(n: number): Promise<Uint8Array> {
    return this.readBuf.readExact(n);
  }

  closeWrite(): void {
    this.writeClosed = true;
  }

  closeRead(): void {
    this.readBuf.close(new EOF());
  }

  close(): void {
    this.closeWrite();
    this.closeRead();
  }
}

/**
 * Creates a paired mock: writes on `a` appear as reads on `b` and vice versa.
 */
export function createMockStreamPair(): [MockYamuxStream, MockYamuxStream] {
  const buf1 = new ByteBuffer();
  const buf2 = new ByteBuffer();
  const a = new MockYamuxStream(buf1, buf2);
  const b = new MockYamuxStream(buf2, buf1);
  return [a, b];
}

export { EOF };

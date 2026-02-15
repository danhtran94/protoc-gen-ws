// App-layer framing over yamux streams.
//
// Frame format: [1 byte type][4 bytes LE length][payload]
// Mirrors the Go server's pkg/ws/stream.go framing protocol.

import { YamuxStream, EOF } from "./yamux.js";

const FRAME_DATA = 0x00;
const FRAME_ERROR = 0x01;
const FRAME_HEADER_SIZE = 5;

/** Error returned when the remote sends an error frame. */
export class RemoteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RemoteError";
  }
}

/** Wraps a YamuxStream with the 5-byte frame protocol. */
export class WSStream {
  constructor(private ys: YamuxStream) {}

  /** Send a data frame with the given payload. */
  async send(data: Uint8Array): Promise<void> {
    const hdr = new Uint8Array(FRAME_HEADER_SIZE);
    const view = new DataView(hdr.buffer);
    hdr[0] = FRAME_DATA;
    view.setUint32(1, data.length, true); // little-endian
    await this.ys.write(hdr);
    if (data.length > 0) {
      await this.ys.write(data);
    }
  }

  /** Receive the next frame payload. Throws RemoteError on error frames. */
  async recv(): Promise<Uint8Array> {
    const hdr = await this.ys.readExact(FRAME_HEADER_SIZE);
    const view = new DataView(hdr.buffer, hdr.byteOffset, hdr.byteLength);
    const typ = hdr[0];
    const length = view.getUint32(1, true); // little-endian

    const payload = length > 0 ? await this.ys.readExact(length) : new Uint8Array(0);

    if (typ === FRAME_ERROR) {
      throw new RemoteError(new TextDecoder().decode(payload));
    }
    return payload;
  }

  /** Half-close the write side via yamux FIN. */
  close(): void {
    this.ys.closeWrite();
  }
}

export { EOF };

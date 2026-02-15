// Minimal client-only yamux multiplexer over WebSocket.
//
// Wire protocol: 12-byte header [version:1][type:1][flags:2][streamID:4][length:4] (Big-Endian)
// Reference: https://github.com/hashicorp/yamux/blob/master/spec.md

import { ByteBuffer } from "./bytebuffer.js";

// --- Constants ---

const VERSION = 0;

const TYPE_DATA = 0;
const TYPE_WINDOW_UPDATE = 1;
const TYPE_PING = 2;
const TYPE_GO_AWAY = 3;

const FLAG_SYN = 0x01;
const FLAG_ACK = 0x02;
const FLAG_FIN = 0x04;
const FLAG_RST = 0x08;

const INITIAL_WINDOW = 256 * 1024; // 256 KB
const HEADER_SIZE = 12;

// --- YamuxStream ---

type StreamState = "open" | "localClose" | "remoteClose" | "closed";

/** A single multiplexed stream within a yamux session. */
export class YamuxStream {
  readonly id: number;
  private sendWindow: number = INITIAL_WINDOW;
  private recvWindow: number = INITIAL_WINDOW;
  private recvBuffer = new ByteBuffer();
  private state: StreamState = "open";
  private sendFrame: (
    type: number,
    flags: number,
    streamID: number,
    length: number,
    data?: Uint8Array,
  ) => void;
  private windowWaiters: Array<{
    resolve: () => void;
    need: number;
  }> = [];

  constructor(
    id: number,
    sendFrame: (
      type: number,
      flags: number,
      streamID: number,
      length: number,
      data?: Uint8Array,
    ) => void,
  ) {
    this.id = id;
    this.sendFrame = sendFrame;
  }

  /** Write data to the remote end. Blocks if the send window is exhausted. */
  async write(data: Uint8Array): Promise<void> {
    if (this.state === "localClose" || this.state === "closed") {
      throw new Error("stream write-closed");
    }

    let offset = 0;
    while (offset < data.length) {
      // Wait for send window if needed
      while (this.sendWindow <= 0) {
        await new Promise<void>((resolve) => {
          this.windowWaiters.push({ resolve, need: 1 });
        });
      }
      const chunk = Math.min(data.length - offset, this.sendWindow);
      const slice = data.subarray(offset, offset + chunk);
      this.sendFrame(TYPE_DATA, 0, this.id, slice.length, slice);
      this.sendWindow -= chunk;
      offset += chunk;
    }
  }

  /** Read exactly `n` bytes from the stream. */
  async readExact(n: number): Promise<Uint8Array> {
    return this.recvBuffer.readExact(n);
  }

  /** Half-close the write side (sends FIN). The remote sees EOF on read. */
  closeWrite(): void {
    if (this.state === "localClose" || this.state === "closed") return;
    this.sendFrame(TYPE_DATA, FLAG_FIN, this.id, 0);
    if (this.state === "remoteClose") {
      this.state = "closed";
    } else {
      this.state = "localClose";
    }
  }

  /** Reset the stream (sends RST). */
  reset(): void {
    if (this.state === "closed") return;
    this.sendFrame(TYPE_DATA, FLAG_RST, this.id, 0);
    this.state = "closed";
    this.recvBuffer.close(new Error("stream reset"));
  }

  // --- Internal methods called by Session read loop ---

  /** @internal Push received data into the stream's read buffer. */
  _onData(data: Uint8Array): void {
    this.recvBuffer.push(data);
    this.recvWindow -= data.length;

    // Send window update if consumed more than half the initial window
    if (this.recvWindow < INITIAL_WINDOW / 2) {
      const delta = INITIAL_WINDOW - this.recvWindow;
      this.sendFrame(TYPE_WINDOW_UPDATE, 0, this.id, delta);
      this.recvWindow = INITIAL_WINDOW;
    }
  }

  /** @internal Remote increased our send window. */
  _onWindowUpdate(delta: number): void {
    this.sendWindow += delta;
    // Wake up writers waiting for window
    const ready: Array<{ resolve: () => void; need: number }> = [];
    const still: Array<{ resolve: () => void; need: number }> = [];
    for (const w of this.windowWaiters) {
      if (this.sendWindow >= w.need) {
        ready.push(w);
      } else {
        still.push(w);
      }
    }
    this.windowWaiters = still;
    for (const w of ready) {
      w.resolve();
    }
  }

  /** @internal Remote closed their write side (FIN). */
  _onRemoteClose(): void {
    if (this.state === "localClose") {
      this.state = "closed";
    } else {
      this.state = "remoteClose";
    }
    this.recvBuffer.close(new EOF());
  }

  /** @internal Remote reset the stream. */
  _onReset(): void {
    this.state = "closed";
    this.recvBuffer.close(new Error("stream reset by remote"));
  }
}

// --- Sentinel Errors ---

/** Indicates end-of-stream (remote half-closed). */
export class EOF extends Error {
  constructor() {
    super("EOF");
    this.name = "EOF";
  }
}

// --- YamuxSession ---

/** Client-side yamux session over a WebSocket. */
export class YamuxSession {
  private ws: WebSocket;
  private streams = new Map<number, YamuxStream>();
  private nextID = 1; // Client uses odd stream IDs
  private sessionBuffer = new ByteBuffer();
  private closed = false;

  private constructor(ws: WebSocket) {
    this.ws = ws;
  }

  /** Connect to a WebSocket URL and establish a yamux session. */
  static async connect(url: string): Promise<YamuxSession> {
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";

    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = (e) => reject(new Error("WebSocket connection failed"));
      ws.onclose = (e) =>
        reject(new Error(`WebSocket closed: ${e.code} ${e.reason}`));
    });

    const session = new YamuxSession(ws);
    session.setupWebSocket();
    session.startReadLoop();
    return session;
  }

  /** Open a new yamux stream. Sends SYN, returns immediately. */
  async open(): Promise<YamuxStream> {
    if (this.closed) throw new Error("session closed");

    const id = this.nextID;
    this.nextID += 2; // Client uses odd IDs

    const stream = new YamuxStream(id, this.sendFrameRaw.bind(this));
    this.streams.set(id, stream);

    // Send SYN with window update (initial window)
    this.sendFrameRaw(TYPE_WINDOW_UPDATE, FLAG_SYN, id, INITIAL_WINDOW);

    return stream;
  }

  /** Close the session gracefully: GoAway + close WebSocket. */
  close(): void {
    if (this.closed) return;
    this.closed = true;

    // Send GoAway (normal termination, code 0)
    this.sendFrameRaw(TYPE_GO_AWAY, 0, 0, 0);

    // Close all streams
    for (const stream of this.streams.values()) {
      stream._onReset();
    }
    this.streams.clear();

    this.ws.close(1000, "yamux session closed");
    this.sessionBuffer.close(new Error("session closed"));
  }

  /** Check if the session is closed. */
  get isClosed(): boolean {
    return this.closed;
  }

  // --- Internal ---

  private setupWebSocket(): void {
    this.ws.onmessage = (event: MessageEvent) => {
      const data = new Uint8Array(event.data as ArrayBuffer);
      this.sessionBuffer.push(data);
    };

    this.ws.onclose = () => {
      this.closed = true;
      this.sessionBuffer.close(new Error("WebSocket closed"));
      for (const stream of this.streams.values()) {
        stream._onReset();
      }
      this.streams.clear();
    };

    this.ws.onerror = () => {
      this.closed = true;
      this.sessionBuffer.close(new Error("WebSocket error"));
    };
  }

  private async startReadLoop(): Promise<void> {
    try {
      await this.readLoop();
    } catch (_) {
      // Session closed or WebSocket error — expected during shutdown
    }
  }

  private async readLoop(): Promise<void> {
    while (!this.closed) {
      // Read 12-byte yamux header
      const hdr = await this.sessionBuffer.readExact(HEADER_SIZE);
      const view = new DataView(hdr.buffer, hdr.byteOffset, hdr.byteLength);

      // const version = hdr[0]; // always 0
      const type = hdr[1];
      const flags = view.getUint16(2, false); // big-endian
      const streamID = view.getUint32(4, false); // big-endian
      const length = view.getUint32(8, false); // big-endian

      switch (type) {
        case TYPE_DATA: {
          let payload: Uint8Array | undefined;
          if (length > 0) {
            payload = await this.sessionBuffer.readExact(length);
          }

          const stream = this.streams.get(streamID);
          if (!stream) {
            // Unknown stream, ignore
            break;
          }

          if (payload && payload.length > 0) {
            stream._onData(payload);
          }
          if (flags & FLAG_FIN) {
            stream._onRemoteClose();
          }
          if (flags & FLAG_RST) {
            stream._onReset();
            this.streams.delete(streamID);
          }
          break;
        }

        case TYPE_WINDOW_UPDATE: {
          const stream = this.streams.get(streamID);
          if (stream) {
            if (flags & FLAG_FIN) {
              stream._onRemoteClose();
            }
            if (flags & FLAG_RST) {
              stream._onReset();
              this.streams.delete(streamID);
            }
            stream._onWindowUpdate(length);
          }
          break;
        }

        case TYPE_PING: {
          // Reply with ACK using the same value
          this.sendFrameRaw(TYPE_PING, FLAG_ACK, 0, length);
          break;
        }

        case TYPE_GO_AWAY: {
          // Server is shutting down
          this.closed = true;
          for (const stream of this.streams.values()) {
            stream._onReset();
          }
          this.streams.clear();
          this.ws.close(1000, "received GoAway");
          return;
        }
      }
    }
  }

  /** Send a raw yamux frame over the WebSocket. */
  private sendFrameRaw(
    type: number,
    flags: number,
    streamID: number,
    length: number,
    data?: Uint8Array,
  ): void {
    const frame = new Uint8Array(HEADER_SIZE + (data?.length ?? 0));
    const view = new DataView(frame.buffer);

    view.setUint8(0, VERSION);
    view.setUint8(1, type);
    view.setUint16(2, flags, false); // big-endian
    view.setUint32(4, streamID, false); // big-endian
    view.setUint32(8, length, false); // big-endian

    if (data && data.length > 0) {
      frame.set(data, HEADER_SIZE);
    }

    this.ws.send(frame);
  }
}

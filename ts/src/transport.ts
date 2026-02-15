// Typed transport helpers used by generated WS client stubs.
//
// Mirrors the Go client patterns in pkg/ws/client.go and pkg/ws/typed_stream.go.
// Compatible with protobuf-es v2 functional API (toBinary/fromBinary + Schema).

import { YamuxSession } from "./yamux.js";
import { WSStream, EOF, RemoteError } from "./stream.js";

export type Deserializer<T> = (bytes: Uint8Array) => T;
export type Serializer<T> = (msg: T) => Uint8Array;

// --- openStream ---

/**
 * Open a named stream: creates a yamux stream, sends the method name as
 * the first data frame, returns the WSStream ready for communication.
 */
export async function openStream(
  session: YamuxSession,
  method: string,
): Promise<WSStream> {
  const ys = await session.open();
  const ws = new WSStream(ys);
  // Send method name as first frame (matches Go router.dispatch)
  await ws.send(new TextEncoder().encode(method));
  return ws;
}

// --- callUnary ---

/**
 * Unary call: open stream -> send method + request -> recv response -> done.
 */
export async function callUnary<Res>(
  session: YamuxSession,
  method: string,
  reqBytes: Uint8Array,
  fromBinary: Deserializer<Res>,
): Promise<Res> {
  const ws = await openStream(session, method);
  // Send request payload
  await ws.send(reqBytes);
  // Read response
  const data = await ws.recv();
  ws.close();
  return fromBinary(data);
}

// --- ServerStream ---

/** Callbacks for push-based stream consumption (browser-friendly). */
export interface StreamListener<T> {
  onMessage: (msg: T) => void;
  onError?: (err: Error) => void;
  onEnd?: () => void;
}

/** Server-streaming: receive multiple messages from the server. */
export class ServerStream<T> implements AsyncIterable<T> {
  private stream: WSStream;
  private fromBinary: Deserializer<T>;
  private done = false;

  constructor(stream: WSStream, fromBinary: Deserializer<T>) {
    this.stream = stream;
    this.fromBinary = fromBinary;
  }

  /** Receive a single message. Throws EOF when the stream ends. */
  async recv(): Promise<T> {
    const data = await this.stream.recv();
    return this.fromBinary(data);
  }

  /**
   * Push-based consumption — starts a background read loop that dispatches
   * to callbacks. Non-blocking, ideal for browser UIs.
   *
   * @example
   * const stream = await client.watchUsers({ role: "admin" });
   * stream.listen({
   *   onMessage: (event) => updateUI(event),
   *   onError:   (err)   => showToast(err.message),
   *   onEnd:     ()      => setStatus("disconnected"),
   * });
   */
  listen(callbacks: StreamListener<T>): void {
    this.readLoop(callbacks);
  }

  /** Iterate over all messages until the stream ends. */
  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    while (!this.done) {
      try {
        yield await this.recv();
      } catch (e) {
        if (e instanceof EOF) {
          this.done = true;
          return;
        }
        throw e;
      }
    }
  }

  /** Close the stream (half-close write side). */
  close(): void {
    this.stream.close();
  }

  private async readLoop(cb: StreamListener<T>): Promise<void> {
    try {
      while (!this.done) {
        const data = await this.stream.recv();
        cb.onMessage(this.fromBinary(data));
      }
    } catch (e) {
      if (e instanceof EOF) {
        this.done = true;
        cb.onEnd?.();
      } else {
        this.done = true;
        cb.onError?.(e instanceof Error ? e : new Error(String(e)));
      }
    }
  }
}

// --- ClientStream ---

/** Client-streaming: send multiple messages, receive one response at the end. */
export class ClientStream<Req, Res> {
  private stream: WSStream;
  private toBinary: Serializer<Req>;
  private fromBinary: Deserializer<Res>;

  constructor(
    stream: WSStream,
    toBinary: Serializer<Req>,
    fromBinary: Deserializer<Res>,
  ) {
    this.stream = stream;
    this.toBinary = toBinary;
    this.fromBinary = fromBinary;
  }

  /** Send a single request message. */
  async send(msg: Req): Promise<void> {
    await this.stream.send(this.toBinary(msg));
  }

  /** Half-close the write side and receive the final response. */
  async closeAndRecv(): Promise<Res> {
    this.stream.close();
    const data = await this.stream.recv();
    return this.fromBinary(data);
  }
}

// --- BidiStream ---

/** Bidirectional streaming: send and receive interleaved messages. */
export class BidiStream<Req, Res> implements AsyncIterable<Res> {
  private stream: WSStream;
  private toBinary: Serializer<Req>;
  private fromBinary: Deserializer<Res>;
  private done = false;

  constructor(
    stream: WSStream,
    toBinary: Serializer<Req>,
    fromBinary: Deserializer<Res>,
  ) {
    this.stream = stream;
    this.toBinary = toBinary;
    this.fromBinary = fromBinary;
  }

  /** Send a single request message. */
  async send(msg: Req): Promise<void> {
    await this.stream.send(this.toBinary(msg));
  }

  /** Receive a single response message. */
  async recv(): Promise<Res> {
    const data = await this.stream.recv();
    return this.fromBinary(data);
  }

  /**
   * Push-based consumption — starts a background read loop that dispatches
   * to callbacks. Send independently with `send()`, close with `close()`.
   * Non-blocking, ideal for browser UIs.
   *
   * @example
   * const stream = await client.syncUsers();
   * stream.listen({
   *   onMessage: (resp) => handleAck(resp),
   *   onError:   (err)  => showToast(err.message),
   *   onEnd:     ()     => setStatus("done"),
   * });
   * // Send whenever — button clicks, form submits, etc.
   * sendBtn.onclick = () => stream.send({ type: "subscribe", userId: "u1" });
   */
  listen(callbacks: StreamListener<Res>): void {
    this.readLoop(callbacks);
  }

  /** Iterate over all response messages until the stream ends. */
  async *[Symbol.asyncIterator](): AsyncIterator<Res> {
    while (!this.done) {
      try {
        yield await this.recv();
      } catch (e) {
        if (e instanceof EOF) {
          this.done = true;
          return;
        }
        throw e;
      }
    }
  }

  /** Close the write side of the stream. */
  close(): void {
    this.stream.close();
  }

  private async readLoop(cb: StreamListener<Res>): Promise<void> {
    try {
      while (!this.done) {
        const data = await this.stream.recv();
        cb.onMessage(this.fromBinary(data));
      }
    } catch (e) {
      if (e instanceof EOF) {
        this.done = true;
        cb.onEnd?.();
      } else {
        this.done = true;
        cb.onError?.(e instanceof Error ? e : new Error(String(e)));
      }
    }
  }
}

export { RemoteError, EOF };

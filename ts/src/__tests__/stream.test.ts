import { describe, it, expect } from "vitest";
import { WSStream, RemoteError } from "../stream.js";
import { createMockStreamPair, EOF } from "./helpers.js";

describe("WSStream", () => {
  it("send encodes data frame correctly", async () => {
    const [clientSide, serverSide] = createMockStreamPair();
    const ws = new WSStream(clientSide as any);

    const payload = new TextEncoder().encode("hello");
    await ws.send(payload);

    // Read the raw frame from the other side: 5-byte header + payload
    const hdr = await serverSide.readExact(5);
    const view = new DataView(hdr.buffer, hdr.byteOffset, hdr.byteLength);

    expect(hdr[0]).toBe(0x00); // FRAME_DATA
    expect(view.getUint32(1, true)).toBe(5); // payload length (LE)

    const body = await serverSide.readExact(5);
    expect(new TextDecoder().decode(body)).toBe("hello");
  });

  it("recv decodes data frame correctly", async () => {
    const [clientSide, serverSide] = createMockStreamPair();
    const ws = new WSStream(clientSide as any);

    // Write a valid data frame from the server side
    const payload = new TextEncoder().encode("world");
    const hdr = new Uint8Array(5);
    const view = new DataView(hdr.buffer);
    hdr[0] = 0x00; // FRAME_DATA
    view.setUint32(1, payload.length, true); // LE
    await serverSide.write(hdr);
    await serverSide.write(payload);

    const result = await ws.recv();
    expect(new TextDecoder().decode(result)).toBe("world");
  });

  it("recv throws RemoteError on error frame", async () => {
    const [clientSide, serverSide] = createMockStreamPair();
    const ws = new WSStream(clientSide as any);

    // Write an error frame
    const errMsg = new TextEncoder().encode("something broke");
    const hdr = new Uint8Array(5);
    const view = new DataView(hdr.buffer);
    hdr[0] = 0x01; // FRAME_ERROR
    view.setUint32(1, errMsg.length, true);
    await serverSide.write(hdr);
    await serverSide.write(errMsg);

    await expect(ws.recv()).rejects.toThrow(RemoteError);
    // Can't check the instance after rejection above, so test separately:
    try {
      // Need a fresh frame for a new recv
      await serverSide.write(hdr);
      await serverSide.write(errMsg);
      await ws.recv();
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(RemoteError);
      expect((e as RemoteError).message).toBe("something broke");
    }
  });

  it("send empty payload", async () => {
    const [clientSide, serverSide] = createMockStreamPair();
    const ws = new WSStream(clientSide as any);

    await ws.send(new Uint8Array(0));

    // Read header — should have length 0 and no payload bytes
    const hdr = await serverSide.readExact(5);
    const view = new DataView(hdr.buffer, hdr.byteOffset, hdr.byteLength);
    expect(hdr[0]).toBe(0x00);
    expect(view.getUint32(1, true)).toBe(0);
  });

  it("roundtrip multiple frames", async () => {
    const [clientSide, serverSide] = createMockStreamPair();
    const clientWS = new WSStream(clientSide as any);
    const serverWS = new WSStream(serverSide as any);

    const messages = ["first", "second", "third"];

    // Client sends 3 frames
    for (const msg of messages) {
      await clientWS.send(new TextEncoder().encode(msg));
    }

    // Server receives 3 frames
    for (const msg of messages) {
      const data = await serverWS.recv();
      expect(new TextDecoder().decode(data)).toBe(msg);
    }
  });

  it("recv throws EOF when stream closes", async () => {
    const [clientSide, serverSide] = createMockStreamPair();
    const ws = new WSStream(clientSide as any);

    // Close the read side (simulates remote FIN)
    serverSide.closeWrite();
    clientSide.closeRead();

    await expect(ws.recv()).rejects.toThrow("EOF");
  });
});

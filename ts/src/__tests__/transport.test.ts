import { describe, it, expect } from "vitest";
import { ServerStream, ClientStream, BidiStream } from "../transport.js";
import { WSStream, RemoteError } from "../stream.js";
import { createMockStreamPair } from "./helpers.js";

// Simple serializer/deserializer for strings (used as test message type)
const encode = (s: string) => new TextEncoder().encode(s);
const decode = (b: Uint8Array) => new TextDecoder().decode(b);

describe("ServerStream", () => {
  it("async iteration yields all messages then stops", async () => {
    const [clientSide, serverSide] = createMockStreamPair();
    const clientWS = new WSStream(clientSide as any);
    const serverWS = new WSStream(serverSide as any);

    const stream = new ServerStream<string>(clientWS, decode);

    // Server sends 3 messages then closes
    const messages = ["alpha", "beta", "gamma"];
    for (const msg of messages) {
      await serverWS.send(encode(msg));
    }
    // Signal end-of-stream by closing the server's write side
    // which closes the client's read side
    serverSide.closeWrite();
    clientSide.closeRead();

    const received: string[] = [];
    for await (const msg of stream) {
      received.push(msg);
    }
    expect(received).toEqual(messages);
  });

  it("recv throws on RemoteError", async () => {
    const [clientSide, serverSide] = createMockStreamPair();
    const clientWS = new WSStream(clientSide as any);

    const stream = new ServerStream<string>(clientWS, decode);

    // Server sends an error frame
    const errMsg = encode("server error");
    const hdr = new Uint8Array(5);
    const view = new DataView(hdr.buffer);
    hdr[0] = 0x01; // FRAME_ERROR
    view.setUint32(1, errMsg.length, true);
    await serverSide.write(hdr);
    await serverSide.write(errMsg);

    await expect(stream.recv()).rejects.toThrow(RemoteError);
  });
});

describe("ClientStream", () => {
  it("send + closeAndRecv", async () => {
    const [clientSide, serverSide] = createMockStreamPair();
    const clientWS = new WSStream(clientSide as any);
    const serverWS = new WSStream(serverSide as any);

    const stream = new ClientStream<string, string>(clientWS, encode, decode);

    // Client sends 2 messages
    await stream.send("msg1");
    await stream.send("msg2");

    // Verify server received them
    const r1 = await serverWS.recv();
    expect(decode(r1)).toBe("msg1");
    const r2 = await serverWS.recv();
    expect(decode(r2)).toBe("msg2");

    // Server sends final response before client calls closeAndRecv
    await serverWS.send(encode("done"));

    const resp = await stream.closeAndRecv();
    expect(resp).toBe("done");
  });
});

describe("BidiStream", () => {
  it("interleaved send/recv", async () => {
    const [clientSide, serverSide] = createMockStreamPair();
    const clientWS = new WSStream(clientSide as any);
    const serverWS = new WSStream(serverSide as any);

    const stream = new BidiStream<string, string>(clientWS, encode, decode);

    // Send, then recv, then send, then recv
    await stream.send("req1");
    const sr1 = await serverWS.recv();
    expect(decode(sr1)).toBe("req1");

    await serverWS.send(encode("res1"));
    const cr1 = await stream.recv();
    expect(cr1).toBe("res1");

    await stream.send("req2");
    const sr2 = await serverWS.recv();
    expect(decode(sr2)).toBe("req2");

    await serverWS.send(encode("res2"));
    const cr2 = await stream.recv();
    expect(cr2).toBe("res2");
  });

  it("async iteration consumes all responses", async () => {
    const [clientSide, serverSide] = createMockStreamPair();
    const clientWS = new WSStream(clientSide as any);
    const serverWS = new WSStream(serverSide as any);

    const stream = new BidiStream<string, string>(clientWS, encode, decode);

    // Server sends 3 responses then closes
    const responses = ["r1", "r2", "r3"];
    for (const r of responses) {
      await serverWS.send(encode(r));
    }
    serverSide.closeWrite();
    clientSide.closeRead();

    const received: string[] = [];
    for await (const msg of stream) {
      received.push(msg);
    }
    expect(received).toEqual(responses);
  });

  it("callUnary roundtrip via raw WSStream", async () => {
    // Tests the callUnary pattern at a lower level
    const [clientSide, serverSide] = createMockStreamPair();
    const clientWS = new WSStream(clientSide as any);
    const serverWS = new WSStream(serverSide as any);

    // Client sends method + request
    await clientWS.send(encode("myService/myMethod"));
    await clientWS.send(encode('{"id":1}'));

    // Server reads method + request
    const method = decode(await serverWS.recv());
    expect(method).toBe("myService/myMethod");

    const reqBody = decode(await serverWS.recv());
    expect(reqBody).toBe('{"id":1}');

    // Server sends response
    await serverWS.send(encode('{"result":"ok"}'));

    // Client reads response
    const respBody = decode(await clientWS.recv());
    expect(respBody).toBe('{"result":"ok"}');
  });
});

import { describe, it, expect } from "vitest";
import { ByteBuffer } from "../bytebuffer.js";

describe("ByteBuffer", () => {
  it("push then readExact — immediate resolve", async () => {
    const buf = new ByteBuffer();
    const data = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    buf.push(data);

    const result = await buf.readExact(10);
    expect(result).toEqual(data);
  });

  it("readExact before push — delayed resolve", async () => {
    const buf = new ByteBuffer();
    const promise = buf.readExact(5);

    // Push data after readExact was called
    buf.push(new Uint8Array([10, 20, 30, 40, 50]));

    const result = await promise;
    expect(result).toEqual(new Uint8Array([10, 20, 30, 40, 50]));
  });

  it("readExact across multiple chunks", async () => {
    const buf = new ByteBuffer();
    buf.push(new Uint8Array([1, 2, 3]));
    buf.push(new Uint8Array([4, 5, 6, 7]));

    const result = await buf.readExact(7);
    expect(result).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6, 7]));
  });

  it("partial consume leaves remainder", async () => {
    const buf = new ByteBuffer();
    buf.push(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]));

    const first = await buf.readExact(3);
    expect(first).toEqual(new Uint8Array([1, 2, 3]));

    const second = await buf.readExact(7);
    expect(second).toEqual(new Uint8Array([4, 5, 6, 7, 8, 9, 10]));
  });

  it("readExact(0) returns empty immediately", async () => {
    const buf = new ByteBuffer();
    const result = await buf.readExact(0);
    expect(result).toEqual(new Uint8Array(0));
    expect(result.length).toBe(0);
  });

  it("close rejects pending readExact", async () => {
    const buf = new ByteBuffer();
    const promise = buf.readExact(100);

    buf.close(new Error("test close"));

    await expect(promise).rejects.toThrow("test close");
  });

  it("push after close is ignored", async () => {
    const buf = new ByteBuffer();
    buf.close();

    // Push after close should be silently ignored
    buf.push(new Uint8Array([1, 2, 3]));

    // readExact should reject because buffer is closed
    await expect(buf.readExact(1)).rejects.toThrow("stream closed");
  });

  it("readExact on closed buffer rejects immediately", async () => {
    const buf = new ByteBuffer();
    buf.close(new Error("already closed"));

    await expect(buf.readExact(5)).rejects.toThrow("already closed");
  });
});

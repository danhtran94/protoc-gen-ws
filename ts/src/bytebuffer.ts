/** Accumulates incoming byte chunks and provides exact-length reads. */
export class ByteBuffer {
  private chunks: Uint8Array[] = [];
  private totalLen = 0;
  private waiting: {
    resolve: (data: Uint8Array) => void;
    reject: (err: Error) => void;
    need: number;
  } | null = null;
  private closed = false;
  private closeError: Error | null = null;

  /** Append data. Resolves any pending readExact if we now have enough bytes. */
  push(data: Uint8Array): void {
    if (this.closed) return;
    if (data.length === 0) return;
    this.chunks.push(data);
    this.totalLen += data.length;
    this.tryResolve();
  }

  /** Signal that no more data will arrive. Pending reads will reject. */
  close(err?: Error): void {
    this.closed = true;
    this.closeError = err ?? new Error("stream closed");
    if (this.waiting) {
      this.waiting.reject(this.closeError);
      this.waiting = null;
    }
  }

  /** Read exactly `n` bytes, blocking (via Promise) until available. */
  async readExact(n: number): Promise<Uint8Array> {
    if (n === 0) return new Uint8Array(0);

    if (this.totalLen >= n) {
      return this.consume(n);
    }
    if (this.closed) {
      throw this.closeError ?? new Error("stream closed");
    }
    return new Promise<Uint8Array>((resolve, reject) => {
      this.waiting = { resolve, reject, need: n };
    });
  }

  private tryResolve(): void {
    if (!this.waiting) return;
    if (this.totalLen >= this.waiting.need) {
      const { resolve, need } = this.waiting;
      this.waiting = null;
      resolve(this.consume(need));
    }
  }

  private consume(n: number): Uint8Array {
    const out = new Uint8Array(n);
    let offset = 0;
    while (offset < n) {
      const chunk = this.chunks[0];
      const take = Math.min(chunk.length, n - offset);
      out.set(chunk.subarray(0, take), offset);
      offset += take;
      if (take === chunk.length) {
        this.chunks.shift();
      } else {
        this.chunks[0] = chunk.subarray(take);
      }
    }
    this.totalLen -= n;
    return out;
  }
}

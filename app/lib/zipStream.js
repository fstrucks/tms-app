// Streaming ZIP writer (no dependency). Writes entries one after another to an async sink, so a part is
// never held in memory: peak is one source chunk plus the sink's small queue.
// Stored entries for files (PDF/JPEG are already compressed); deflated entries for CSV/JSON text.
// Every entry uses a data descriptor, so sizes and CRC can be written after the data. No ZIP64: parts stay far below 4 GB.
import { deflateRawSync, constants as Z } from 'node:zlib';

const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
export function crc32(buf, crc = 0) {
  let c = ~crc >>> 0;
  for (let i = 0; i < buf.length; i++) c = TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

const LOCAL = 30, DESC = 16, CENTRAL = 46, END = 22;
// Bytes an entry adds besides its data (local header + descriptor + its central record).
export const entryOverhead = (name) => LOCAL + DESC + CENTRAL + 2 * Buffer.byteLength(name, 'utf8');
export const END_BYTES = END;

function dosTime(d) {
  const t = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const day = ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { t, day };
}

export class ZipWriter {
  // write(chunk: Uint8Array) => Promise<void>
  constructor(write, { now = new Date() } = {}) {
    this.write = write; this.offset = 0; this.entries = []; this.open = null; this.central = 0; this.time = dosTime(now);
  }
  async #out(b) { this.offset += b.length; await this.write(b); }
  // Bytes the archive would have if closed right now (used for the part size limit).
  projected(extra = 0) { return this.offset + this.central + END + extra + (this.open ? DESC + CENTRAL + this.open.name.length + 8 : 0); }

  async begin(name, { deflate = false } = {}) {
    if (this.open) throw new Error('entry_open');
    const nameBuf = Buffer.from(name, 'utf8');
    const h = Buffer.alloc(LOCAL);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0808, 6); // data descriptor + UTF-8
    h.writeUInt16LE(deflate ? 8 : 0, 8); h.writeUInt16LE(this.time.t, 10); h.writeUInt16LE(this.time.day, 12);
    h.writeUInt16LE(nameBuf.length, 26);
    this.open = { name: nameBuf, method: deflate ? 8 : 0, at: this.offset, crc: 0, size: 0, csize: 0, deflate };
    await this.#out(h); await this.#out(nameBuf);
  }
  async data(chunk) {
    const e = this.open; if (!e) throw new Error('no_entry');
    const b = chunk instanceof Uint8Array ? chunk : Buffer.from(String(chunk), 'utf8');
    e.crc = crc32(b, e.crc); e.size += b.length;
    // Each text chunk is its own deflate block (sync flush), so the output length is known right away.
    const out = e.deflate ? deflateRawSync(b, { finishFlush: Z.Z_SYNC_FLUSH }) : b;
    e.csize += out.length;
    if (out.length) await this.#out(out);
  }
  async end() {
    const e = this.open; if (!e) throw new Error('no_entry');
    if (e.deflate) { const fin = deflateRawSync(Buffer.alloc(0)); e.csize += fin.length; await this.#out(fin); }
    const d = Buffer.alloc(DESC);
    d.writeUInt32LE(0x08074b50, 0); d.writeUInt32LE(e.crc, 4); d.writeUInt32LE(e.csize, 8); d.writeUInt32LE(e.size, 12);
    await this.#out(d);
    this.entries.push(e); this.central += CENTRAL + e.name.length; this.open = null;
  }
  async file(name, bytes, opts) { await this.begin(name, opts); await this.data(bytes); await this.end(); }
  async finish() {
    if (this.open) await this.end();
    const start = this.offset; let size = 0;
    for (const e of this.entries) {
      const c = Buffer.alloc(CENTRAL);
      c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0808, 8);
      c.writeUInt16LE(e.method, 10); c.writeUInt16LE(this.time.t, 12); c.writeUInt16LE(this.time.day, 14);
      c.writeUInt32LE(e.crc, 16); c.writeUInt32LE(e.csize, 20); c.writeUInt32LE(e.size, 24);
      c.writeUInt16LE(e.name.length, 28); c.writeUInt32LE(e.at, 42);
      await this.#out(c); await this.#out(e.name); size += CENTRAL + e.name.length;
    }
    const z = Buffer.alloc(END);
    z.writeUInt32LE(0x06054b50, 0); z.writeUInt16LE(this.entries.length, 8); z.writeUInt16LE(this.entries.length, 10);
    z.writeUInt32LE(size, 12); z.writeUInt32LE(start, 16);
    await this.#out(z);
    return { bytes: this.offset, entries: this.entries.length };
  }
}

// A sink backed by a ReadableStream with a bounded queue, for streaming uploads.
// write() waits while the consumer is behind, so memory stays at about highWaterMark bytes.
export function streamSink({ highWaterMark = 4 * 1024 * 1024 } = {}) {
  const ts = new TransformStream({}, new ByteLengthQueuingStrategy({ highWaterMark }), new ByteLengthQueuingStrategy({ highWaterMark }));
  const w = ts.writable.getWriter();
  return {
    readable: ts.readable,
    write: async (b) => { await w.ready; await w.write(b); },
    close: () => w.close(),
    abort: (e) => w.abort(e).catch(() => {}),
  };
}

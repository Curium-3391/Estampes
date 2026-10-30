// A minimal ZIP writer and a defensive reader for .estampes bundles. No
// dependencies: Node's zlib does the deflating and the CRC. The reader
// accepts only what the writer produces plus ordinary zips (stored or
// deflated, no encryption, no zip64, no multi-disk) and refuses anything
// that could escape a folder or blow up memory.
import { deflateRawSync, inflateRawSync, crc32 } from "node:zlib";

const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
// Fixed time (1980-01-01) so the same files always give the same bytes.
const DOS_TIME = 0, DOS_DATE = (0 << 9) | (1 << 5) | 1;
export const SAFE_NAME = /^(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;

// files: [{ name, data: Buffer, store?: true }] → Buffer
export function zipFiles(files) {
  const locals = [], central = [];
  let offset = 0;
  for (const { name, data, store } of files) {
    if (!SAFE_NAME.test(name) || name.length > 200) throw new Error("Unsafe file name in bundle: " + name);
    const nameBuf = Buffer.from(name, "utf8"), crc = crc32(data);
    const packed = store ? data : deflateRawSync(data, { level: 9 });
    const method = store || packed.length >= data.length ? 0 : 8;
    const body = method === 0 ? data : packed;
    const head = Buffer.concat([u32(0x04034b50), u16(20), u16(0x0800), u16(method), u16(DOS_TIME), u16(DOS_DATE),
      u32(crc), u32(body.length), u32(data.length), u16(nameBuf.length), u16(0), nameBuf]);
    locals.push(head, body);
    central.push(Buffer.concat([u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(method), u16(DOS_TIME), u16(DOS_DATE),
      u32(crc), u32(body.length), u32(data.length), u16(nameBuf.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), nameBuf]));
    offset += head.length + body.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.concat([u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length), u32(cd.length), u32(offset), u16(0)]);
  return Buffer.concat([...locals, cd, end]);
}

// → Map(name → Buffer). Limits: entries, total uncompressed bytes, ratio.
export function unzipFiles(buf, { maxEntries = 400, maxTotal = 400 * 1024 * 1024, maxEntry = 200 * 1024 * 1024 } = {}) {
  const fail = (m) => { throw new Error("Not a valid .estampes bundle: " + m); };
  if (buf.length < 22) fail("too small");
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) fail("no zip directory (is it a zip?)");
  const count = buf.readUInt16LE(eocd + 10), cdSize = buf.readUInt32LE(eocd + 12), cdOff = buf.readUInt32LE(eocd + 16);
  if (buf.readUInt16LE(eocd + 4) !== 0 || count === 0xffff || cdOff === 0xffffffff) fail("multi-disk and zip64 files are not supported");
  if (count > maxEntries) fail("too many files (" + count + ")");
  if (cdOff + cdSize > eocd) fail("directory out of range");
  const out = new Map();
  let p = cdOff, total = 0;
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) fail("damaged directory");
    const flags = buf.readUInt16LE(p + 8), method = buf.readUInt16LE(p + 10), crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24);
    const nl = buf.readUInt16LE(p + 28), el = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32), lo = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nl);
    p += 46 + nl + el + cl;
    if (name.endsWith("/")) continue;
    if (!SAFE_NAME.test(name)) fail("unsafe file name " + JSON.stringify(name));
    if (out.has(name)) fail("duplicate file " + name);
    if (flags & 1) fail("encrypted files are not supported");
    if (![0, 8].includes(method)) fail("unsupported compression in " + name);
    if (usize > maxEntry || (total += usize) > maxTotal) fail("too large when unpacked");
    if (lo + 30 > buf.length || buf.readUInt32LE(lo) !== 0x04034b50) fail("damaged entry " + name);
    const start = lo + 30 + buf.readUInt16LE(lo + 26) + buf.readUInt16LE(lo + 28);
    if (start + csize > buf.length) fail("entry " + name + " runs past the end");
    const raw = buf.subarray(start, start + csize);
    let data;
    try { data = method === 0 ? Buffer.from(raw) : inflateRawSync(raw, { maxOutputLength: usize + 1 }); } catch { fail("cannot unpack " + name); }
    if (data.length !== usize || crc32(data) !== crc) fail("checksum mismatch in " + name);
    out.set(name, data);
  }
  return out;
}

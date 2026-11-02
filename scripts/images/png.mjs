/**
 * Just enough PNG to trim a screenshot: 8-bit RGBA, no interlacing, which is what
 * a Chromium capture writes. No dependency: this repository has none and a docs
 * script must not be the first.
 *
 * @module scripts/images/png
 */

import { deflateSync, inflateSync } from "node:zlib";

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** The PNG chunk CRC, computed the same way the spec's sample code does. */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = ~0;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 255] ^ (c >>> 8);
  return ~c >>> 0;
}

/** One chunk: length, type, payload, CRC over type+payload. */
function chunk(type, payload) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(payload.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), payload]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** The five row filters the spec defines, applied to one scanline. */
function unfilter(filter, line, previous, stride, bpp) {
  const out = Buffer.alloc(stride);
  for (let x = 0; x < stride; x++) {
    const a = x >= bpp ? out[x - bpp] : 0;
    const b = previous === undefined ? 0 : previous[x];
    const c = previous !== undefined && x >= bpp ? previous[x - bpp] : 0;
    let value = line[x];
    if (filter === 1) value += a;
    else if (filter === 2) value += b;
    else if (filter === 3) value += (a + b) >> 1;
    else if (filter === 4) {
      const p = a + b - c;
      const pa = Math.abs(p - a);
      const pb = Math.abs(p - b);
      const pc = Math.abs(p - c);
      value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
    } else if (filter !== 0) throw new Error(`unsupported PNG row filter ${filter}`);
    out[x] = value & 255;
  }
  return out;
}

/**
 * @param {Buffer} buffer
 * @returns {{ width: number, height: number, data: Buffer }} RGBA, top-down.
 */
export function decode(buffer) {
  if (!buffer.subarray(0, 8).equals(SIGNATURE)) throw new Error("not a PNG");
  let i = 8;
  let header;
  const idat = [];
  while (i < buffer.length) {
    const length = buffer.readUInt32BE(i);
    const type = buffer.toString("ascii", i + 4, i + 8);
    const payload = buffer.subarray(i + 8, i + 8 + length);
    if (type === "IHDR") {
      header = {
        width: payload.readUInt32BE(0),
        height: payload.readUInt32BE(4),
        depth: payload[8],
        color: payload[9],
        interlace: payload[12],
      };
    } else if (type === "IDAT") idat.push(payload);
    else if (type === "IEND") break;
    i += 12 + length;
  }
  if (header === undefined) throw new Error("PNG has no IHDR");
  if (header.depth !== 8 || header.color !== 6 || header.interlace !== 0) {
    throw new Error(
      `unsupported PNG (depth ${header.depth}, color ${header.color}, interlace ${header.interlace})`,
    );
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = header.width * 4;
  const data = Buffer.alloc(stride * header.height);
  let offset = 0;
  for (let y = 0; y < header.height; y++) {
    const filter = raw[offset++];
    const line = raw.subarray(offset, offset + stride);
    offset += stride;
    unfilter(
      filter,
      line,
      y === 0 ? undefined : data.subarray((y - 1) * stride, y * stride),
      stride,
      4,
    ).copy(data, y * stride);
  }
  return { width: header.width, height: header.height, data };
}

/** @param {{ width: number, height: number, data: Buffer }} image */
export function encode(image) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(image.width, 0);
  header.writeUInt32BE(image.height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  const stride = image.width * 4;
  const raw = Buffer.alloc((stride + 1) * image.height);
  for (let y = 0; y < image.height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    image.data.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    SIGNATURE,
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * The box of everything above `threshold` alpha: the cards, their shadows'
 * visible edge, and nothing else. Undefined for a fully transparent image.
 * @param {{ width: number, height: number, data: Buffer }} image
 * @param {number} threshold 0-255
 */
export function alphaBox(image, threshold) {
  const { width, height, data } = image;
  let left = width;
  let top = height;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] <= threshold) continue;
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
    }
  }
  return right < 0 ? undefined : { left, top, right: right + 1, bottom: bottom + 1 };
}

/** @param {{ width: number, height: number, data: Buffer }} image */
export function crop(image, left, top, right, bottom) {
  const width = right - left;
  const height = bottom - top;
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    image.data.copy(
      data,
      y * width * 4,
      ((top + y) * image.width + left) * 4,
      ((top + y) * image.width + right) * 4,
    );
  }
  return { width, height, data };
}

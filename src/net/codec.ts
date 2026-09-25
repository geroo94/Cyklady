/**
 * @file Kodeki wiadomości: JSON (ramki tekstowe) i MessagePack (ramki binarne).
 *
 * Protokół jest niezależny od kodowania. JSON łatwo czytać w narzędziach
 * deweloperskich, a MessagePack daje mniejsze wiadomości. W LAN klient
 * wybiera kodek podprotokołem WebSocket (`cyklady.v1.json` /
 * `cyklady.v1.msgpack`).
 *
 * MessagePack jest zaimplementowany w podzbiorze wystarczającym dla danych
 * zgodnych z JSON: nil, bool, liczby całkowite i zmiennoprzecinkowe, napisy,
 * tablice i mapy z kluczami tekstowymi. Dekoder pilnuje granic bufora,
 * głębokości zagnieżdżenia i poprawności UTF-8, a klucza `__proto__` nie
 * zamienia w prototyp obiektu.
 */

export type CodecName = 'json' | 'msgpack';

export interface MessageCodec {
  readonly name: CodecName;
  encode(message: unknown): string | Uint8Array;
  decode(data: string | Uint8Array): unknown;
}

const utf8 = new TextDecoder('utf-8', { fatal: true });
const utf8Encoder = new TextEncoder();

export const JSON_CODEC: MessageCodec = {
  name: 'json',
  encode: (message) => JSON.stringify(message),
  decode: (data) => JSON.parse(typeof data === 'string' ? data : utf8.decode(data)),
};

// ===========================================================================
// MessagePack: koder
// ===========================================================================

class ByteWriter {
  #buffer = new Uint8Array(256);
  #view = new DataView(this.#buffer.buffer);
  #length = 0;

  #reserve(extra: number): void {
    if (this.#length + extra <= this.#buffer.length) return;
    let size = this.#buffer.length * 2;
    while (size < this.#length + extra) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.#buffer.subarray(0, this.#length));
    this.#buffer = next;
    this.#view = new DataView(next.buffer);
  }

  u8(value: number): void {
    this.#reserve(1);
    this.#view.setUint8(this.#length, value);
    this.#length += 1;
  }
  u16(value: number): void {
    this.#reserve(2);
    this.#view.setUint16(this.#length, value);
    this.#length += 2;
  }
  u32(value: number): void {
    this.#reserve(4);
    this.#view.setUint32(this.#length, value);
    this.#length += 4;
  }
  i8(value: number): void {
    this.#reserve(1);
    this.#view.setInt8(this.#length, value);
    this.#length += 1;
  }
  i16(value: number): void {
    this.#reserve(2);
    this.#view.setInt16(this.#length, value);
    this.#length += 2;
  }
  i32(value: number): void {
    this.#reserve(4);
    this.#view.setInt32(this.#length, value);
    this.#length += 4;
  }
  f64(value: number): void {
    this.#reserve(8);
    this.#view.setFloat64(this.#length, value);
    this.#length += 8;
  }
  bytes(data: Uint8Array): void {
    this.#reserve(data.length);
    this.#buffer.set(data, this.#length);
    this.#length += data.length;
  }
  result(): Uint8Array {
    return this.#buffer.slice(0, this.#length);
  }
}

function encodeValue(writer: ByteWriter, value: unknown, depth: number): void {
  if (depth > MAX_DEPTH) throw new Error('MessagePack: zbyt głębokie zagnieżdżenie');
  if (value === null || value === undefined) return writer.u8(0xc0);
  if (value === false) return writer.u8(0xc2);
  if (value === true) return writer.u8(0xc3);
  if (typeof value === 'number') return encodeNumber(writer, value);
  if (typeof value === 'string') return encodeString(writer, value);
  if (Array.isArray(value)) {
    header(writer, value.length, 0x90, 0xdc, 0xdd);
    for (const item of value) encodeValue(writer, item, depth + 1);
    return;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined);
    header(writer, entries.length, 0x80, 0xde, 0xdf);
    for (const [key, item] of entries) {
      encodeString(writer, key);
      encodeValue(writer, item, depth + 1);
    }
    return;
  }
  throw new Error(`MessagePack: nieobsługiwany typ ${typeof value}`);
}

/** Nagłówek tablicy lub mapy: fix (do 15 elementów), 16 bitów albo 32 bity. */
function header(writer: ByteWriter, length: number, fix: number, code16: number, code32: number): void {
  if (length < 16) writer.u8(fix | length);
  else if (length < 0x10000) {
    writer.u8(code16);
    writer.u16(length);
  } else {
    writer.u8(code32);
    writer.u32(length);
  }
}

/**
 * Liczby całkowite w najkrótszej postaci (fixint, 8/16/32 bity), pozostałe
 * jako float64. Float64 dokładnie reprezentuje każdą bezpieczną liczbę całkowitą.
 */
function encodeNumber(writer: ByteWriter, value: number): void {
  if (!Number.isFinite(value)) throw new Error('MessagePack: liczba musi być skończona');
  if (Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff) {
    if (value < 0x80) {
      writer.u8(value);
    } else if (value <= 0xff) {
      writer.u8(0xcc);
      writer.u8(value);
    } else if (value <= 0xffff) {
      writer.u8(0xcd);
      writer.u16(value);
    } else {
      writer.u8(0xce);
      writer.u32(value);
    }
    return;
  }
  if (Number.isSafeInteger(value) && value < 0 && value >= -0x80000000) {
    if (value >= -32) {
      writer.i8(value);
    } else if (value >= -0x80) {
      writer.u8(0xd0);
      writer.i8(value);
    } else if (value >= -0x8000) {
      writer.u8(0xd1);
      writer.i16(value);
    } else {
      writer.u8(0xd2);
      writer.i32(value);
    }
    return;
  }
  writer.u8(0xcb);
  writer.f64(value);
}

function encodeString(writer: ByteWriter, value: string): void {
  const bytes = utf8Encoder.encode(value);
  const length = bytes.length;
  if (length < 32) writer.u8(0xa0 | length);
  else if (length < 0x100) {
    writer.u8(0xd9);
    writer.u8(length);
  } else if (length < 0x10000) {
    writer.u8(0xda);
    writer.u16(length);
  } else {
    writer.u8(0xdb);
    writer.u32(length);
  }
  writer.bytes(bytes);
}

// ===========================================================================
// MessagePack: dekoder
// ===========================================================================

const MAX_DEPTH = 64;

class ByteReader {
  readonly #view: DataView;
  readonly #bytes: Uint8Array;
  offset = 0;

  constructor(bytes: Uint8Array) {
    this.#bytes = bytes;
    this.#view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  #need(count: number): void {
    if (this.offset + count > this.#bytes.length) throw new Error('MessagePack: dane urwane w połowie wartości');
  }
  u8(): number {
    this.#need(1);
    return this.#view.getUint8(this.offset++);
  }
  u16(): number {
    this.#need(2);
    const value = this.#view.getUint16(this.offset);
    this.offset += 2;
    return value;
  }
  u32(): number {
    this.#need(4);
    const value = this.#view.getUint32(this.offset);
    this.offset += 4;
    return value;
  }
  i8(): number {
    this.#need(1);
    return this.#view.getInt8(this.offset++);
  }
  i16(): number {
    this.#need(2);
    const value = this.#view.getInt16(this.offset);
    this.offset += 2;
    return value;
  }
  i32(): number {
    this.#need(4);
    const value = this.#view.getInt32(this.offset);
    this.offset += 4;
    return value;
  }
  f32(): number {
    this.#need(4);
    const value = this.#view.getFloat32(this.offset);
    this.offset += 4;
    return value;
  }
  f64(): number {
    this.#need(8);
    const value = this.#view.getFloat64(this.offset);
    this.offset += 8;
    return value;
  }
  big(signed: boolean): number {
    this.#need(8);
    const value = signed ? this.#view.getBigInt64(this.offset) : this.#view.getBigUint64(this.offset);
    this.offset += 8;
    const result = Number(value);
    if (!Number.isSafeInteger(result)) throw new Error('MessagePack: liczba 64-bitowa poza bezpiecznym zakresem');
    return result;
  }
  text(length: number): string {
    this.#need(length);
    const value = utf8.decode(this.#bytes.subarray(this.offset, this.offset + length));
    this.offset += length;
    return value;
  }
  get remaining(): number {
    return this.#bytes.length - this.offset;
  }
}

function decodeValue(reader: ByteReader, depth: number): unknown {
  if (depth > MAX_DEPTH) throw new Error('MessagePack: zbyt głębokie zagnieżdżenie');
  const code = reader.u8();
  if (code <= 0x7f) return code;
  if (code >= 0xe0) return code - 0x100;
  if (code >= 0x80 && code <= 0x8f) return decodeMap(reader, code & 0x0f, depth);
  if (code >= 0x90 && code <= 0x9f) return decodeArray(reader, code & 0x0f, depth);
  if (code >= 0xa0 && code <= 0xbf) return reader.text(code & 0x1f);
  switch (code) {
    case 0xc0:
      return null;
    case 0xc2:
      return false;
    case 0xc3:
      return true;
    case 0xca:
      return reader.f32();
    case 0xcb:
      return reader.f64();
    case 0xcc:
      return reader.u8();
    case 0xcd:
      return reader.u16();
    case 0xce:
      return reader.u32();
    case 0xcf:
      return reader.big(false);
    case 0xd0:
      return reader.i8();
    case 0xd1:
      return reader.i16();
    case 0xd2:
      return reader.i32();
    case 0xd3:
      return reader.big(true);
    case 0xd9:
      return reader.text(reader.u8());
    case 0xda:
      return reader.text(reader.u16());
    case 0xdb:
      return reader.text(reader.u32());
    case 0xdc:
      return decodeArray(reader, reader.u16(), depth);
    case 0xdd:
      return decodeArray(reader, reader.u32(), depth);
    case 0xde:
      return decodeMap(reader, reader.u16(), depth);
    case 0xdf:
      return decodeMap(reader, reader.u32(), depth);
    default:
      throw new Error(`MessagePack: nieobsługiwany znacznik 0x${code.toString(16)}`);
  }
}

function decodeArray(reader: ByteReader, length: number, depth: number): unknown[] {
  // Każdy element zajmuje co najmniej bajt: długość większa niż reszta danych to atak albo błąd.
  if (length > reader.remaining) throw new Error('MessagePack: deklarowana długość tablicy przekracza dane');
  const items: unknown[] = [];
  for (let i = 0; i < length; i++) items.push(decodeValue(reader, depth + 1));
  return items;
}

function decodeMap(reader: ByteReader, length: number, depth: number): Record<string, unknown> {
  if (length * 2 > reader.remaining) throw new Error('MessagePack: deklarowana długość mapy przekracza dane');
  const result: Record<string, unknown> = {};
  for (let i = 0; i < length; i++) {
    const key = decodeValue(reader, depth + 1);
    if (typeof key !== 'string') throw new Error('MessagePack: klucz mapy musi być napisem');
    // defineProperty tworzy zwykłą własność także dla klucza "__proto__" (bez podmiany prototypu).
    Object.defineProperty(result, key, { value: decodeValue(reader, depth + 1), enumerable: true, writable: true, configurable: true });
  }
  return result;
}

export const MSGPACK_CODEC: MessageCodec = {
  name: 'msgpack',
  encode(message) {
    const writer = new ByteWriter();
    encodeValue(writer, message, 0);
    return writer.result();
  },
  decode(data) {
    if (typeof data === 'string') throw new Error('MessagePack: oczekiwano danych binarnych');
    const reader = new ByteReader(data);
    const value = decodeValue(reader, 0);
    if (reader.remaining !== 0) throw new Error('MessagePack: nadmiarowe bajty po wartości');
    return value;
  },
};

export const CODECS: Readonly<Record<CodecName, MessageCodec>> = { json: JSON_CODEC, msgpack: MSGPACK_CODEC };

// -----------------------------------------------------------------------------
// Risco local protocol frames, ported from pyrisco (pyrisco/local/risco_crypt.py,
// MIT, see THIRD_PARTY_NOTICES.md):
//
//   STX [0x11 if scrambled] escape(scramble("<id:2><command>\x17<CRC>")) ETX
//
// - the CRC is CRC-16/MODBUS (table of pyrisco, init 0xFFFF) over
//   "<id><command>\x17", written as 4 upper-case hex digits;
// - the scrambling is a XOR with a 255-byte pseudo-random buffer derived
//   from the panel id (the answer to `RID`), byte i with buffer[i];
// - DLE, STX and ETX inside the frame are escaped by a DLE.
//
// Changed from pyrisco: frames are cut by one linear pass that follows the
// escapes (pyrisco re-reads until the frame does not end with DLE ETX, which
// a real DLE before the ETX defeats), their length is bounded, and the CRC is
// computed over the bytes received rather than over their text re-encoded.
// The scrambling is not encryption: it hides nothing from anyone who knows
// the panel id, which the panel gives to whoever asks.
// -----------------------------------------------------------------------------

import { LIMITS } from '../constants.js';

const STX = 0x02;
const ETX = 0x03;
const DLE = 0x10;
const SCRAMBLED = 0x11;
const SEPARATOR = 0x17;
const BUFFER_LENGTH = 255;

/** Error replies carry no command id: `N05`, `B03`… */
const isErrorReply = (text) => text[0] === 'N' || text[0] === 'B';

export const CRC_TABLE = (() => {
  const table = new Array(256);
  for (let i = 0; i < 256; i += 1) {
    let crc = i;
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
    table[i] = crc;
  }
  return table;
})();

/** CRC of the bytes, as the panel writes it ("4FCA"). */
export function crc(bytes) {
  let value = 0xffff;
  for (const byte of bytes) value = (value >>> 8) ^ CRC_TABLE[(value ^ byte) & 0xff];
  return value.toString(16).toUpperCase().padStart(4, '0');
}

/** The scrambling buffer of a panel id (all zeros for id 0: no scrambling). */
export function pseudoBuffer(panelId) {
  const buffer = new Uint8Array(BUFFER_LENGTH);
  if (!panelId) return buffer;
  // Only bits 1, 2, 4 and 15 feed back, only bits 0-7 are kept: 16 bits are enough.
  let pid = panelId & 0xffff;
  for (let i = 0; i < BUFFER_LENGTH; i += 1) {
    let bit = 0;
    for (const mask of [2, 4, 16, 32768]) if (pid & mask) bit ^= 1;
    pid = ((pid << 1) | bit) & 0xffff;
    buffer[i] = pid & 0xff;
  }
  return buffer;
}

function scramble(bytes, buffer) {
  if (bytes.length > BUFFER_LENGTH) throw new Error('Risco frame too long to scramble');
  return bytes.map((byte, i) => byte ^ buffer[i]);
}

export class FrameError extends Error {}

/**
 * Codec of one session: it knows the panel id once `RID` answered, and
 * scrambles its frames when the panel's last frame was scrambled (as pyrisco).
 */
export class RiscoCodec {
  constructor() {
    this.buffer = undefined;
    this.scrambled = false;
  }

  setPanelId(panelId) {
    this.buffer = pseudoBuffer(panelId);
  }

  /** A command -> the bytes to write. */
  encode(id, command) {
    const body = Buffer.from(`${String(id).padStart(2, '0')}${command}\x17`, 'utf8');
    let bytes = Uint8Array.from([...body, ...Buffer.from(crc(body), 'latin1')]);
    const scrambling = this.scrambled;
    if (scrambling) {
      if (!this.buffer) throw new FrameError('The panel scrambles before giving its id');
      bytes = scramble(bytes, this.buffer);
    }
    const out = [STX];
    if (scrambling) out.push(SCRAMBLED);
    for (const byte of bytes) {
      if (byte === DLE || byte === STX || byte === ETX) out.push(DLE);
      out.push(byte);
    }
    out.push(ETX);
    return Buffer.from(out);
  }

  /**
   * A whole frame (STX … ETX, as cut by FrameReader) -> { id, text, crcOk }.
   * `id` is null for an error reply (`N05`).
   */
  decode(frame) {
    if (frame.length < 3 || frame[0] !== STX || frame[frame.length - 1] !== ETX) {
      throw new FrameError('Not a Risco frame');
    }
    const scrambled = frame[1] === SCRAMBLED;
    this.scrambled = scrambled;
    const raw = [];
    for (let i = scrambled ? 2 : 1; i < frame.length - 1; i += 1) {
      if (frame[i] === DLE && i + 1 < frame.length - 1) i += 1;
      raw.push(frame[i]);
    }
    let bytes = Uint8Array.from(raw);
    if (scrambled) {
      if (!this.buffer) throw new FrameError('Scrambled frame before the panel id is known');
      bytes = scramble(bytes, this.buffer);
    }
    const end = bytes.indexOf(SEPARATOR);
    if (end < 0) throw new FrameError('Risco frame without separator');
    const head = bytes.subarray(0, end + 1);
    const tail = Buffer.from(bytes.subarray(end + 1)).toString('latin1');
    const command = new TextDecoder('utf-8').decode(bytes.subarray(0, end));
    const crcOk = /^[0-9A-F]{4}$/.test(tail) && crc(head) === tail;
    if (isErrorReply(command)) return { id: null, text: command, crcOk };
    const id = Number(command.slice(0, 2));
    if (!/^\d{2}$/.test(command.slice(0, 2))) throw new FrameError('Risco frame without id');
    return { id, text: command.slice(2), crcOk };
  }
}

/** Cuts the byte stream into frames, following the escapes, in one pass. */
export class FrameReader {
  constructor({ onFrame, onDrop = () => undefined, maxFrame = LIMITS.maxFrame }) {
    this.onFrame = onFrame;
    this.onDrop = onDrop;
    this.maxFrame = maxFrame;
    this.reset();
  }

  reset() {
    this.bytes = [];
    this.inFrame = false;
    this.escaped = false;
  }

  push(chunk) {
    for (const byte of chunk) {
      if (!this.inFrame) {
        if (byte === STX) {
          this.inFrame = true;
          this.bytes = [STX];
        }
        continue;
      }
      if (this.escaped) {
        this.escaped = false;
        this.bytes.push(byte);
      } else if (byte === DLE) {
        this.escaped = true;
        this.bytes.push(byte);
      } else if (byte === STX) {
        // A start inside a frame: the previous one was cut, keep the new one.
        this.onDrop('frame cut by a new start');
        this.bytes = [STX];
        continue;
      } else {
        this.bytes.push(byte);
        if (byte === ETX) {
          const frame = Buffer.from(this.bytes);
          this.reset();
          this.onFrame(frame);
          continue;
        }
      }
      if (this.bytes.length > this.maxFrame) {
        this.onDrop('frame too long');
        this.reset();
      }
    }
  }
}

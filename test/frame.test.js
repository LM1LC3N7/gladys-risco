// The frames, checked against pyrisco 0.8.1 itself: the expected bytes below
// were produced by pyrisco/local/risco_crypt.py (RiscoCrypt.encode, _get_crc,
// _create_pseudo_buffer) run on the same inputs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CRC_TABLE, FrameReader, RiscoCodec, crc, pseudoBuffer } from '../src/risco/frame.js';

// pyrisco ships its CRC table as base64 (risco_crypt.py, CRC_ARRAY_BASE64); ours is
// computed (CRC-16/MODBUS): the whole table is compared.
const PYRISCO_CRC_TABLE = JSON.parse(
  Buffer.from(
    'WzAsNDkzNDUsNDk1MzcsMzIwLDQ5OTIxLDk2MCw2NDAsNDk3MjksNTA2ODksMTcyOCwxOTIwLDUxMDA5LDEyODAsNTA2MjUsNTAzMDUsMTA4OCw1MjIyNSwzMjY0LDM0NTYsNTI1NDUsMzg0MCw1MzE4NSw1Mjg2NSwzNjQ4LDI1NjAsNTE5MDUsNTIwOTcsMjg4MCw1MTQ1NywyNDk2LDIxNzYsNTEyNjUsNTUyOTcsNjMzNiw2NTI4LDU1NjE3LDY5MTIsNTYyNTcsNTU5MzcsNjcyMCw3NjgwLDU3MDI1LDU3MjE3LDgwMDAsNTY1NzcsNzYxNiw3Mjk2LDU2Mzg1LDUxMjAsNTQ0NjUsNTQ2NTcsNTQ0MCw1NTA0MSw2MDgwLDU3NjAsNTQ4NDksNTM3NjEsNDgwMCw0OTkyLDU0MDgxLDQzNTIsNTM2OTcsNTMzNzcsNDE2MCw2MTQ0MSwxMjQ4MCwxMjY3Miw2MTc2MSwxMzA1Niw2MjQwMSw2MjA4MSwxMjg2NCwxMzgyNCw2MzE2OSw2MzM2MSwxNDE0NCw2MjcyMSwxMzc2MCwxMzQ0MCw2MjUyOSwxNTM2MCw2NDcwNSw2NDg5NywxNTY4MCw2NTI4MSwxNjMyMCwxNjAwMCw2NTA4OSw2NDAwMSwxNTA0MCwxNTIzMiw2NDMyMSwxNDU5Miw2MzkzNyw2MzYxNywxNDQwMCwxMDI0MCw1OTU4NSw1OTc3NywxMDU2MCw2MDE2MSwxMTIwMCwxMDg4MCw1OTk2OSw2MDkyOSwxMTk2OCwxMjE2MCw2MTI0OSwxMTUyMCw2MDg2NSw2MDU0NSwxMTMyOCw1ODM2OSw5NDA4LDk2MDAsNTg2ODksOTk4NCw1OTMyOSw1OTAwOSw5NzkyLDg3MDQsNTgwNDksNTgyNDEsOTAyNCw1NzYwMSw4NjQwLDgzMjAsNTc0MDksNDA5NjEsMjQ3NjgsMjQ5NjAsNDEyODEsMjUzNDQsNDE5MjEsNDE2MDEsMjUxNTIsMjYxMTIsNDI2ODksNDI4ODEsMjY0MzIsNDIyNDEsMjYwNDgsMjU3MjgsNDIwNDksMjc2NDgsNDQyMjUsNDQ0MTcsMjc5NjgsNDQ4MDEsMjg2MDgsMjgyODgsNDQ2MDksNDM1MjEsMjczMjgsMjc1MjAsNDM4NDEsMjY4ODAsNDM0NTcsNDMxMzcsMjY2ODgsMzA3MjAsNDcyOTcsNDc0ODksMzEwNDAsNDc4NzMsMzE2ODAsMzEzNjAsNDc2ODEsNDg2NDEsMzI0NDgsMzI2NDAsNDg5NjEsMzIwMDAsNDg1NzcsNDgyNTcsMzE4MDgsNDYwODEsMjk4ODgsMzAwODAsNDY0MDEsMzA0NjQsNDcwNDEsNDY3MjEsMzAyNzIsMjkxODQsNDU3NjEsNDU5NTMsMjk1MDQsNDUzMTMsMjkxMjAsMjg4MDAsNDUxMjEsMjA0ODAsMzcwNTcsMzcyNDksMjA4MDAsMzc2MzMsMjE0NDAsMjExMjAsMzc0NDEsMzg0MDEsMjIyMDgsMjI0MDAsMzg3MjEsMjE3NjAsMzgzMzcsMzgwMTcsMjE1NjgsMzk5MzcsMjM3NDQsMjM5MzYsNDAyNTcsMjQzMjAsNDA4OTcsNDA1NzcsMjQxMjgsMjMwNDAsMzk2MTcsMzk4MDksMjMzNjAsMzkxNjksMjI5NzYsMjI2NTYsMzg5NzcsMzQ4MTcsMTg2MjQsMTg4MTYsMzUxMzcsMTkyMDAsMzU3NzcsMzU0NTcsMTkwMDgsMTk5NjgsMzY1NDUsMzY3MzcsMjAyODgsMzYwOTcsMTk5MDQsMTk1ODQsMzU5MDUsMTc0MDgsMzM5ODUsMzQxNzcsMTc3MjgsMzQ1NjEsMTgzNjgsMTgwNDgsMzQzNjksMzMyODEsMTcwODgsMTcyODAsMzM2MDEsMTY2NDAsMzMyMTcsMzI4OTcsMTY0NDhd',
    'base64',
  ).toString('utf8'),
);

const hex = (buffer) => Buffer.from(buffer).toString('hex');

test('the CRC table and the CRC are those of pyrisco', () => {
  assert.equal(PYRISCO_CRC_TABLE.length, 256);
  assert.deepEqual(CRC_TABLE, PYRISCO_CRC_TABLE);
  assert.equal(crc(Buffer.from('01RID\x17')), '4FCA');
  assert.equal(crc(Buffer.from('51ACK\x17')), '6CEB');
});

test('the scrambling buffer of a panel id is the one of pyrisco', () => {
  const cases = {
    0x1234: ['68d0a143870e1d3a74e8d1a2458a152a', '7bf6edda'],
    0x0001: ['02050b172f5ebd7af4e8d0a142850b16', 'f7efdfbf'],
    0xbeef: ['dfbf7efcf9f2e5cb962c58b162c48811', '82040913'],
    0x7fff: ['fffefcf9f2e5ca942953a74f9f3e7cf9', 'd6ad5ab5'],
  };
  for (const [id, [start, end]] of Object.entries(cases)) {
    const buffer = pseudoBuffer(Number(id));
    assert.equal(buffer.length, 255);
    assert.equal(hex(buffer.subarray(0, 16)), start, `id ${id}`);
    assert.equal(hex(buffer.subarray(-4)), end, `id ${id}`);
  }
  assert.ok(
    pseudoBuffer(0).every((b) => b === 0),
    'id 0: no scrambling',
  );
});

test('frames are encoded byte for byte like pyrisco, escapes included', () => {
  const codec = new RiscoCodec();
  assert.equal(hex(codec.encode(1, 'RID')), '023031524944173446434103');
  const cases = {
    0x1234: ['021158e7f11010d35a2c0563a9e9947403', '021159e2f30ed333280c43d0c69676ba5603'],
    0x0001: ['021132325b447b0a8c45e3a9e8977303', '02113337595a7b63884cc3d0c79571b54803'],
    0xbeef: ['0211ef882eafada6d4f4816d60875303', '0211ee8d2cb1adcfd0fda1144f8551f4cb03'],
    0x7fff: ['0211cfc9acaaa6b1fbab3e129f79ae03', '0211ceccaeb4a6d8ffa21e6bb07bac0e3f03'],
  };
  for (const [id, [pstt, rmt]] of Object.entries(cases)) {
    codec.setPanelId(Number(id));
    codec.scrambled = true;
    assert.equal(hex(codec.encode(7, 'PSTT1?')), pstt, `PSTT1? with id ${id}`);
    assert.equal(hex(codec.encode(12, 'RMT=5678')), rmt, `RMT with id ${id}`);
  }
});

test('decoding gives back the id, the text and a valid CRC', () => {
  const codec = new RiscoCodec();
  codec.setPanelId(0x1234);
  codec.scrambled = true;
  const frame = codec.encode(7, 'PSTT1=--E-R---');
  const reader = new RiscoCodec();
  reader.setPanelId(0x1234);
  assert.deepEqual(reader.decode(frame), { id: 7, text: 'PSTT1=--E-R---', crcOk: true });
  assert.equal(reader.scrambled, true, 'the next frames are scrambled too');
  const damaged = Buffer.from(frame);
  damaged[5] ^= 0x01;
  assert.equal(reader.decode(damaged).crcOk, false);
  const plain = new RiscoCodec();
  assert.deepEqual(plain.decode(plain.encode(0, 'N05').subarray(0)), {
    id: 0,
    text: 'N05',
    crcOk: true,
  });
});

test('an error answer has no id', () => {
  const codec = new RiscoCodec();
  const body = Buffer.from('N05\x17');
  const frame = Buffer.concat([Buffer.from([2]), body, Buffer.from(crc(body)), Buffer.from([3])]);
  assert.deepEqual(codec.decode(frame), { id: null, text: 'N05', crcOk: true });
});

test('a scrambled frame before the panel id is an error, never garbage', () => {
  const sender = new RiscoCodec();
  sender.setPanelId(0x1234);
  sender.scrambled = true;
  assert.throws(() => new RiscoCodec().decode(sender.encode(1, 'RID=1234')), /panel id/);
});

test('the reader follows the escapes: a real DLE before ETX ends the frame', () => {
  const frames = [];
  const drops = [];
  const reader = new FrameReader({
    onFrame: (f) => frames.push(hex(f)),
    onDrop: (w) => drops.push(w),
  });
  // 0x1234 PSTT1? holds an escaped DLE (10 10) right in the middle.
  const one = Buffer.from('021158e7f11010d35a2c0563a9e9947403', 'hex');
  // A frame whose last data byte is an escaped DLE: ... 10 10 03 (pyrisco
  // would read on, as the frame "ends with DLE ETX").
  const two = Buffer.from('0231101003', 'hex');
  const three = Buffer.from('023031524944173446434103', 'hex');
  const stream = Buffer.concat([Buffer.from('ff', 'hex'), one, two, three]);
  for (const byte of stream) reader.push([byte]);
  assert.deepEqual(frames, [hex(one), hex(two), hex(three)]);
  assert.deepEqual(drops, []);
});

test('the reader drops a frame that never ends', () => {
  const frames = [];
  const drops = [];
  const reader = new FrameReader({
    onFrame: (f) => frames.push(f),
    onDrop: (w) => drops.push(w),
    maxFrame: 32,
  });
  reader.push(Buffer.concat([Buffer.from([2]), Buffer.alloc(100, 0x41)]));
  reader.push(Buffer.from('023031524944173446434103', 'hex'));
  assert.equal(frames.length, 1);
  assert.deepEqual(drops, ['frame too long']);
});

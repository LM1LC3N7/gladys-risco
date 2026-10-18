// RiscoClient against the in-memory panel (test/helpers/fakeRisco.js).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LIMITS, TIMINGS } from '../src/constants.js';
import { RiscoClient, RiscoError } from '../src/risco/client.js';
import { crc } from '../src/risco/frame.js';
import { FakeRisco, quietLogger, settle, until } from './helpers/fakeRisco.js';

function setup(t, options = {}, { code = '5678', timers } = {}) {
  const panel = new FakeRisco(options);
  const logger = quietLogger();
  const client = new RiscoClient({ connect: panel.connect, logger, timers });
  client.configure({ host: '192.0.2.20', port: 1000, code });
  const ups = [];
  const downs = [];
  client.on('up', (info) => ups.push(info));
  client.on('down', (info) => downs.push(info));
  t.after(() => client.stop());
  return { panel, client, logger, ups, downs };
}

test('login, then the discovery of the zones, partitions and system', async (t) => {
  const { panel, client, ups } = setup(t);
  client.start();
  await until(() => ups.length === 1);
  const { snapshot } = ups[0];
  assert.deepEqual(panel.requests.slice(0, 7), [
    'RID',
    'LCL',
    'RMT=5678',
    'PNLCNF',
    'FSVER?',
    'PNLSERD',
    'ZTYPE*1?',
  ]);
  assert.equal(snapshot.panel.model, 'LightSYS');
  assert.equal(snapshot.panel.zones, 50, 'firmware 3: 50 zones');
  assert.equal(snapshot.panel.serial, '123456789');
  assert.deepEqual(Object.keys(snapshot.zones), ['1', '2', '5']);
  assert.equal(snapshot.zones[1].label, 'Porte entree', 'labels are trimmed');
  assert.deepEqual(snapshot.zones[5].partitions, [1, 2]);
  assert.deepEqual(Object.keys(snapshot.partitions), ['1', '2']);
  assert.equal(snapshot.system.label, 'Ma maison');
  assert.ok(client.connected);
  assert.equal(panel.requests.filter((r) => r.startsWith('ZTYPE')).length, 50);
});

test('an Agility (legacy) panel: no FSVER?, no ZLNKTYP', async (t) => {
  const { panel, client, ups } = setup(t, { type: 'RW132:2.00' });
  client.start();
  await until(() => ups.length === 1);
  assert.equal(ups[0].snapshot.panel.model, 'Agility');
  assert.ok(!panel.requests.includes('FSVER?'));
  assert.ok(!panel.requests.some((r) => r.startsWith('ZLNKTYP')));
  assert.equal(panel.requests.filter((r) => r.startsWith('ZTYPE')).length, 36);
});

test('the panel messages are acknowledged and reported once up', async (t) => {
  const { panel, client, ups } = setup(t);
  const zones = [];
  const partitions = [];
  client.on('zone', (z) => zones.push(z));
  client.on('partition', (p) => partitions.push(p));
  client.start();
  await until(() => ups.length === 1);
  panel.push('ZSTT2=O-------');
  panel.push('PSTT1=A-E-----');
  panel.push('CLOCK=18/10/2026 12:00');
  await settle();
  assert.deepEqual(zones, [{ id: 2, status: 'O-------' }]);
  assert.deepEqual(partitions, [{ id: 1, status: 'A-E-----' }]);
});

test('a refused access code stops the logins: no loop, nothing in the logs', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const { panel, client, downs, logger } = setup(t, {}, { code: '1111', timers: globalThis });
  client.start();
  await until(() => downs.length === 1);
  assert.equal(downs[0].refused, true);
  assert.equal(downs[0].stopped, true);
  assert.equal(downs[0].retryIn, undefined);
  t.mock.timers.tick(24 * 3600_000);
  await settle();
  assert.equal(panel.sockets.length, 1, 'never tried again');
  assert.ok(!logger.lines.some((line) => line.includes('1111')), 'the code is never logged');
});

test('a panel that closes at each access code is a refusal on the second time', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const { panel, client, downs } = setup(t, { refuse: 'close' }, { code: '1111' });
  client.start();
  await until(() => downs.length === 1);
  assert.equal(downs[0].refused, false);
  assert.equal(downs[0].retryIn, TIMINGS.backoff[0]);
  t.mock.timers.tick(TIMINGS.backoff[0]);
  await until(() => downs.length === 2);
  assert.equal(downs[1].refused, true);
  t.mock.timers.tick(24 * 3600_000);
  await settle();
  assert.equal(panel.sockets.length, LIMITS.loginDrops);
});

test('an unreachable panel: spaced tries, longer and longer', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const { panel, client, downs, ups } = setup(t, { refuseConnections: 3 });
  client.start();
  for (let i = 0; i < 3; i += 1) {
    await until(() => downs.length === i + 1);
    assert.equal(downs[i].retryIn, TIMINGS.backoff[i]);
    assert.ok(downs[i].retryIn >= 6_000, 'never under the encryption reset time');
    t.mock.timers.tick(downs[i].retryIn);
  }
  await until(() => ups.length === 1);
  assert.equal(panel.sockets.length, 4);
});

test('a timeout during the discovery fails the session, never a partial list', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const { panel, client, downs, ups } = setup(t);
  panel.hold = (text) => text === 'ZLBL*2?';
  client.start();
  await until(() => panel.requests.includes('ZLBL*2?'));
  t.mock.timers.tick(TIMINGS.requestTimeout);
  await until(() => downs.length === 1);
  assert.equal(ups.length, 0);
  assert.match(downs[0].reason, /No answer to ZLBL\*2\?/);
});

test('one request on the wire at a time; an error answer is a panel error', async (t) => {
  const { panel, client, ups } = setup(t);
  client.start();
  await until(() => ups.length === 1);
  let inflight = 0;
  let most = 0;
  const original = panel.receive.bind(panel);
  panel.receive = (socket, frame) => {
    inflight += 1;
    most = Math.max(most, inflight);
    original(socket, frame);
    queueMicrotask(() => (inflight -= 1));
  };
  const reads = await Promise.all([
    client.readPartition(1),
    client.readZone(1),
    client.readZone(2),
  ]);
  assert.deepEqual(reads, ['--E-R---', '--------', '--------']);
  assert.equal(most, 1);
  await assert.rejects(client.arm(9), (err) => err instanceof RiscoError && err.kind === 'panel');
});

test('an error answer without id: the next request takes the id again (pyrisco)', async (t) => {
  const { panel, client, ups } = setup(t);
  client.start();
  await until(() => ups.length === 1);
  const before = client.lastId;
  panel.reply = (text) => (text === 'PSTT1?' ? null : undefined);
  const pending = client.readPartition(1);
  await settle();
  // The panel answers N05 without an id.
  const body = Buffer.from('N05\x17');
  panel.current.raw(
    Buffer.concat([Buffer.from([2]), body, Buffer.from(crc(body)), Buffer.from([3])]),
  );
  await assert.rejects(pending, (err) => err.kind === 'panel' && err.code === 'N05');
  assert.equal(client.lastId, before);
});

test('a request withdrawn before it is written is not sent', async (t) => {
  const { panel, client, ups } = setup(t);
  client.start();
  await until(() => ups.length === 1);
  panel.hold = (text) => text === 'PSTT1?';
  const first = client.readPartition(1, { timeout: 60_000 }).catch((err) => err);
  const ticket = {};
  const second = client.arm(1, { ticket }).catch((err) => err);
  await settle();
  assert.equal(ticket.written, false);
  assert.equal(ticket.cancel(), true);
  const err = await second;
  assert.equal(err.kind, 'late');
  assert.equal(err.sent, false);
  assert.ok(!panel.commands.includes('ARM=1'));
  client.stop();
  assert.equal((await first).sent, true, 'the read in flight may have reached the panel');
});

test('stop sends DCN and frees the panel', async (t) => {
  const { panel, client, ups } = setup(t);
  client.start();
  await until(() => ups.length === 1);
  const socket = panel.current;
  client.stop();
  await settle();
  assert.equal(panel.requests.at(-1), 'DCN');
  assert.equal(socket.ended, true);
});

const errorWithoutId = (code) => {
  const body = Buffer.from(`${code}\x17`);
  return Buffer.concat([Buffer.from([2]), body, Buffer.from(crc(body)), Buffer.from([3])]);
};

test('I2: PSTT times out, DISARM is written, a late N05 comes: ambiguous, id kept', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const { panel, client, ups } = setup(t);
  client.start();
  await until(() => ups.length === 1);
  panel.hold = (text) => text === 'PSTT1?' || text === 'DISARM=1';
  const read = client.readPartition(1).catch((err) => err);
  await settle();
  t.mock.timers.tick(TIMINGS.requestTimeout);
  assert.equal((await read).kind, 'timeout');
  const disarm = client.disarm(1).catch((err) => err);
  await until(() => panel.requests.includes('DISARM=1'));
  const before = client.lastId;
  panel.current.raw(errorWithoutId('N05'));
  const err = await disarm;
  assert.equal(err.kind, 'ambiguous');
  assert.equal(err.sent, true);
  assert.equal(client.lastId, before, 'the id is never taken back on an ambiguous error');
  // An answer with its id puts the line back in step.
  panel.hold = () => false;
  await client.readPartition(2);
  assert.equal(client.uncertain, false);
});

test('M1: never a new session sooner than 6 s after the last one closed', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const { panel, client, ups } = setup(t);
  client.start();
  await until(() => ups.length === 1);
  client.start(); // a new code, "Test the connection"…
  await settle();
  assert.equal(panel.sockets.length, 1);
  t.mock.timers.tick(TIMINGS.sessionGap - 1);
  await settle();
  assert.equal(panel.sockets.length, 1);
  t.mock.timers.tick(1);
  await until(() => ups.length === 2);
  assert.equal(panel.sockets.length, 2);
});

test('M4: a write buffer over 64 KB cuts the session', async (t) => {
  const { panel, client, ups, downs } = setup(t);
  client.start();
  await until(() => ups.length === 1);
  panel.current.writableLength = LIMITS.maxPendingWrite + 1;
  panel.push('ZSTT1=O-------');
  await until(() => downs.length === 1);
  assert.equal(downs[0].reason, 'write buffer full');
});

test('M5: DCN is sent once logged in, even during the discovery', async (t) => {
  const { panel, client } = setup(t);
  panel.gate = (text) => (text === 'ZTYPE*3?' ? new Promise(() => undefined) : undefined);
  client.start();
  await until(() => panel.requests.includes('ZTYPE*3?'));
  client.stop();
  await settle();
  assert.equal(panel.requests.at(-1), 'DCN');
});

test('N1: a command whose check fails right before the write is withdrawn', async (t) => {
  const { panel, client, ups } = setup(t);
  client.start();
  await until(() => ups.length === 1);
  let allowed = true;
  panel.gate = (text) =>
    text === 'PSTT1?' ? Promise.resolve().then(() => (allowed = false)) : undefined;
  const read = client.readPartition(1);
  const disarm = client.disarm(1, { check: () => allowed }).catch((err) => err);
  await read;
  const err = await disarm;
  assert.equal(err.kind, 'withdrawn');
  assert.equal(err.sent, false);
  assert.ok(!panel.commands.includes('DISARM=1'));
});

test('N2: a damaged or unexpected discovery answer is asked again, never "no zone"', async (t) => {
  const once = setup(t);
  let bad = 1;
  once.panel.reply = (text) => (text === 'ZLBL*2?' && bad-- > 0 ? 'garbage' : undefined);
  once.client.start();
  await until(() => once.ups.length === 1);
  assert.ok(once.ups[0].snapshot.zones[2], 'asked again, zone 2 kept');
  assert.equal(once.panel.requests.filter((r) => r === 'ZLBL*2?').length, 2);

  const twice = setup(t);
  twice.panel.reply = (text) => (text === 'ZLBL*2?' ? 'garbage' : undefined);
  twice.client.start();
  await until(() => twice.downs.length === 1);
  assert.equal(twice.ups.length, 0, 'the session fails, no partial list');
  assert.match(twice.downs[0].reason, /no clear answer to ZLBL\*2\?/);
});

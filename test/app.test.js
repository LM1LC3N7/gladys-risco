// RiscoApp with the SDK's fake Gladys (createFakeGladys) and the in-memory
// panel (test/helpers/fakeRisco.js): the whole chain from the panel frames to
// the Gladys devices, states, scene events and commands.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { RiscoApp } from '../src/app.js';
import { TIMINGS } from '../src/constants.js';
import { registerHandlers } from '../src/handlers.js';
import { memoryStore } from '../src/store.js';
import { crc } from '../src/risco/frame.js';
import { FakeRisco, quietLogger, settle, until } from './helpers/fakeRisco.js';

const BASE = { host: '192.0.2.20', access_code: '5678', language: 'en' };

async function setup(t, { config = {}, panel: panelOptions = {}, store, devices } = {}) {
  const gladys = createFakeGladys({ config: { ...BASE, ...config }, devices });
  const panel = new FakeRisco(panelOptions);
  const logger = quietLogger();
  const memory = store ?? memoryStore();
  const app = new RiscoApp({ gladys, logger, connect: panel.connect, store: memory });
  registerHandlers(gladys, app, logger);
  await gladys.connect();
  t.after(() => app.stop({ final: true }));
  const device = (externalId) =>
    gladys.fake.discoveredDevices.find((d) => d.external_id === externalId);
  const ctx = {
    gladys,
    panel,
    app,
    logger,
    store: memory,
    device,
    panelIds: gladys.externalIds('panel', 'risco'),
    partition: (n = 1) => gladys.externalIds('partition', String(n)),
    zone: (n) => gladys.externalIds('zone', String(n)),
    state: (id) => gladys.fake.lastState(id),
    events: () => gladys.fake.sceneEvents,
    press: (ids, key, value = 1) => {
      const d = device(ids.device);
      const feature = d.features.find((f) => f.external_id === ids.feature(key));
      return gladys.fake.setValue(d, feature, value);
    },
  };
  return ctx;
}

const up = async (ctx) => {
  await until(() => ctx.app.online);
  await ctx.app.chain;
  await settle();
};

test('start: the devices, read-only states and push buttons, the status', async (t) => {
  const ctx = await setup(t, { config: { zone_kinds: '2:motion' } });
  await up(ctx);
  const { gladys, partition, zone, panelIds } = ctx;
  assert.deepEqual(
    gladys.fake.discoveredDevices.map((d) => [d.external_id, d.name]),
    [
      [panelIds.device, 'Risco panel'],
      [partition(1).device, 'Maison'],
      [partition(2).device, 'Garage'],
      [zone(1).device, 'Porte entree'],
      [zone(2).device, 'Couloir'],
      [zone(5).device, 'Garage'],
    ],
  );
  const p1 = ctx.device(partition(1).device);
  for (const f of p1.features) {
    assert.notEqual(f.category, 'switch', `${f.external_id}: never a switch`);
    if (f.read_only === false) {
      assert.deepEqual([f.category, f.type], ['button', 'push'], `${f.external_id}: a button`);
    }
  }
  assert.deepEqual(
    p1.features.filter((f) => !f.read_only).map((f) => f.external_id.split(':').at(-1)),
    ['arm-away', 'arm-stay', 'disarm'],
  );
  assert.equal(ctx.device(zone(2).device).features[0].category, 'motion-sensor');
  assert.equal(ctx.device(zone(1).device).features[0].category, 'opening-sensor');
  assert.equal(ctx.state(partition(1).feature('mode')), 'Disarmed');
  assert.equal(ctx.state(partition(1).feature('ready')), 1);
  assert.equal(ctx.state(zone(1).feature('opening')), 1, 'opening: 1 = closed (core)');
  assert.equal(ctx.state(panelIds.feature('online')), 1);
  assert.equal(ctx.state(panelIds.feature('ac-power')), 1);
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.match(
    gladys.fake.connectionStatus.message.en,
    /LightSYS panel \(1: disarmed, 2: disarmed\), 3 zone/,
  );
  assert.ok(gladys.fake.transports.every((entry) => entry.transport === 'local'));
});

test('panel messages become states and scene events', async (t) => {
  const ctx = await setup(t);
  await up(ctx);
  const { panel, partition, zone } = ctx;
  panel.push('ZSTT1=O------b');
  panel.push('PSTT1=A-E-----');
  await settle();
  assert.equal(ctx.state(zone(1).feature('opening')), 0, 'open');
  assert.equal(ctx.state(zone(1).feature('battery-low')), 1);
  assert.equal(ctx.state(partition(1).feature('mode')), 'Armed (away)');
  assert.deepEqual(ctx.events().at(-1), {
    key: 'armed',
    data: { partition: '1', mode: 'armed_away', by_gladys: false },
  });
  panel.push('ZSTT1=O------a');
  panel.push('PSTT1=A-E-a---');
  await settle();
  assert.deepEqual(ctx.events().at(-1), {
    key: 'alarm_triggered',
    data: { partition: '1', zone: 1 },
  });
  assert.equal(ctx.state(partition(1).feature('alarm')), 1);
  panel.push('PSTT1=--E-----');
  await settle();
  assert.deepEqual(ctx.events().at(-1), {
    key: 'disarmed',
    data: { partition: '1', by_gladys: false },
  });
});

test('arm away: decided on the status read now, sent once, credited to Gladys', async (t) => {
  const ctx = await setup(t);
  await up(ctx);
  const ack = await ctx.press(ctx.partition(1), 'arm-away');
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(ctx.panel.requests.slice(-2), ['PSTT1?', 'ARM=1']);
  await settle();
  assert.equal(ctx.state(ctx.partition(1).feature('mode')), 'Armed (away)');
  assert.deepEqual(ctx.events().at(-1).data, {
    partition: '1',
    mode: 'armed_away',
    by_gladys: true,
  });
  // Already armed: nothing sent. Stay while armed away: refused, nothing sent.
  assert.equal((await ctx.press(ctx.partition(1), 'arm-away')).success, true);
  const stay = await ctx.press(ctx.partition(1), 'arm-stay');
  assert.equal(stay.success, false);
  assert.match(stay.error, /another mode.*nothing was sent/);
  assert.deepEqual(ctx.panel.commands, ['ARM=1']);
});

test('the memory never decides: the panel status read before the command does', async (t) => {
  const ctx = await setup(t);
  await up(ctx);
  // Armed from a keypad, no message received: Gladys still shows disarmed.
  ctx.panel.partitions[1].status = 'H-E-----';
  assert.equal(ctx.state(ctx.partition(1).feature('mode')), 'Disarmed');
  const ack = await ctx.press(ctx.partition(1), 'arm-away');
  assert.equal(ack.success, false);
  assert.match(ack.error, /another mode/);
  assert.deepEqual(ctx.panel.commands, []);
});

test('disarming is off by default: nothing read, nothing sent', async (t) => {
  const ctx = await setup(t);
  await up(ctx);
  ctx.panel.partitions[1].status = 'A-E-----';
  const before = ctx.panel.requests.length;
  const ack = await ctx.press(ctx.partition(1), 'disarm');
  assert.equal(ack.success, false);
  assert.match(ack.error, /Disarming from Gladys is disabled.*nothing was sent/);
  assert.equal(ctx.panel.requests.length, before);
  const scene = await ctx.gladys.fake.sceneAction('disarm', { partition: '1' });
  assert.equal(scene.success, false);
  assert.deepEqual(ctx.panel.commands, []);
  assert.ok(ctx.logger.lines.some((l) => /warn Disarm REFUSED/.test(l)));
});

test('disarming when allowed', async (t) => {
  const ctx = await setup(t, { config: { allow_disarm: true } });
  await up(ctx);
  ctx.panel.partitions[1].status = 'A-E-----';
  const ack = await ctx.press(ctx.partition(1), 'disarm');
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(ctx.panel.commands, ['DISARM=1']);
  // Already disarmed: nothing sent.
  await ctx.gladys.fake.sceneAction('disarm', { partition: '1' });
  assert.deepEqual(ctx.panel.commands, ['DISARM=1']);
});

test('arming is refused when the configuration forbids it', async (t) => {
  const ctx = await setup(t, { config: { allow_arm: false } });
  await up(ctx);
  const ack = await ctx.gladys.fake.sceneAction('arm', { partition: '1', mode: 'armed_stay' });
  assert.equal(ack.success, false);
  assert.deepEqual(ctx.panel.commands, []);
});

test('only a push acts; a read-only feature takes no command', async (t) => {
  const ctx = await setup(t);
  await up(ctx);
  for (const value of [0, '', null, 2, '1.0']) {
    const ack = await ctx.press(ctx.partition(1), 'arm-away', value);
    assert.equal(ack.success, false, `value ${JSON.stringify(value)}`);
  }
  const ack = await ctx.press(ctx.partition(1), 'mode', 'Armed (away)');
  assert.equal(ack.success, false);
  assert.match(ack.error, /read-only/);
  assert.deepEqual(ctx.panel.commands, []);
});

test('bypass: off by default, then a toggle guarded until the panel shows it', async (t) => {
  const off = await setup(t);
  await up(off);
  assert.equal((await off.press(off.zone(2), 'bypass')).success, false);
  assert.deepEqual(off.panel.commands, []);
  off.app.stop({ final: true });

  const ctx = await setup(t, { config: { allow_bypass: true } });
  await up(ctx);
  // The panel acknowledges but its status says nothing yet.
  ctx.panel.reply = (text) => (text === 'ZBYPAS=2' ? 'ACK' : undefined);
  assert.equal((await ctx.press(ctx.zone(2), 'bypass')).success, true);
  assert.deepEqual(ctx.panel.commands, ['ZBYPAS=2']);
  const again = await ctx.press(ctx.zone(2), 'bypass');
  assert.equal(again.success, false, 'a second toggle would undo the first');
  assert.match(again.error, /not confirmed yet/);
  // Unbypass of a zone the panel still shows not bypassed: nothing to do.
  assert.equal((await ctx.press(ctx.zone(2), 'unbypass')).success, true);
  assert.deepEqual(ctx.panel.commands, ['ZBYPAS=2']);
  // The panel shows the bypass: the guard falls.
  ctx.panel.zones[2].status = '---Y----';
  ctx.panel.push('ZSTT2=---Y----');
  await settle();
  assert.equal(ctx.state(ctx.zone(2).feature('bypassed')), 1);
  assert.equal((await ctx.press(ctx.zone(2), 'bypass')).success, true, 'already bypassed');
  ctx.panel.reply = () => undefined;
  assert.equal((await ctx.press(ctx.zone(2), 'unbypass')).success, true);
  assert.deepEqual(ctx.panel.commands, ['ZBYPAS=2', 'ZBYPAS=2']);
  assert.equal(ctx.panel.zones[2].status.includes('Y'), false);
});

test('no answer to a command: "sent, not confirmed", never "not sent"; read again', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const ctx = await setup(t);
  await up(ctx);
  ctx.panel.hold = (text) => text === 'ARM=1';
  const pending = ctx.press(ctx.partition(1), 'arm-away');
  await until(() => ctx.panel.commands.includes('ARM=1'));
  t.mock.timers.tick(TIMINGS.answerBy);
  const ack = await pending;
  assert.equal(ack.success, false);
  assert.match(ack.error, /Sent to the panel .*without confirmation/);
  assert.doesNotMatch(ack.error, /nothing was sent/);
  const reads = ctx.panel.requests.filter((r) => r === 'PSTT1?').length;
  t.mock.timers.tick(TIMINGS.requestTimeout);
  await settle();
  t.mock.timers.tick(TIMINGS.readBack);
  await until(() => ctx.panel.requests.filter((r) => r === 'PSTT1?').length > reads);
});

test('a status that cannot be read in time: nothing sent', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const ctx = await setup(t);
  await up(ctx);
  ctx.panel.hold = (text) => text === 'PSTT1?';
  const pending = ctx.press(ctx.partition(1), 'arm-away');
  await until(() => ctx.panel.requests.includes('PSTT1?'));
  t.mock.timers.tick(TIMINGS.readBefore);
  const ack = await pending;
  assert.equal(ack.success, false);
  assert.match(ack.error, /could not be read.*nothing was sent/);
  assert.deepEqual(ctx.panel.commands, []);
});

test('the panel refuses a command: said so, with its answer', async (t) => {
  const ctx = await setup(t);
  await up(ctx);
  ctx.panel.reply = (text) => (text === 'STAY=1' ? 'N19' : undefined);
  const ack = await ctx.press(ctx.partition(1), 'arm-stay');
  assert.equal(ack.success, false);
  assert.match(ack.error, /refused the command .*N19/);
});

test('a refused code is never sent again, even after a restart', async (t) => {
  const store = memoryStore();
  const first = await setup(t, { config: { access_code: '1111' }, store });
  await until(() => first.gladys.fake.connectionStatus?.message?.en?.includes('refused'));
  assert.equal(store.data.stop.kind, 'code_refused');
  assert.equal(JSON.stringify(store.data).includes('1111'), false, 'never the code in /data');
  first.app.stop({ final: true });

  const second = await setup(t, { config: { access_code: '1111' }, store });
  await settle();
  assert.equal(second.panel.sockets.length, 0, 'no connection after the restart');
  assert.match(second.gladys.fake.connectionStatus.message.en, /refused the access code/);
  // A new code lifts the stop.
  await second.gladys.fake.configUpdated({ ...BASE, access_code: '5678' });
  await up(second);
  assert.equal(store.data.stop, null);
});

test('"Test the connection" lifts a stop and answers what the panel holds', async (t) => {
  const store = memoryStore({ stop: { place: '192.0.2.20:1000', kind: 'code_refused', at: 1 } });
  const ctx = await setup(t, { store });
  await settle();
  assert.equal(ctx.panel.sockets.length, 0);
  const ack = await ctx.gladys.fake.action('test_connection');
  assert.equal(ack.success, true, ack.error);
  assert.match(ack.data?.message?.en ?? JSON.stringify(ack.data), /LightSYS/);
  assert.equal(store.data.stop, null);
});

test('a device published again keeps the features the user created', async (t) => {
  const gladys = createFakeGladys({ config: BASE });
  const zone2 = gladys.externalIds('zone', '2');
  const created = {
    name: 'Couloir',
    external_id: zone2.device,
    features: [
      {
        name: 'Opening',
        external_id: zone2.feature('opening'),
        category: 'opening-sensor',
        type: 'binary',
        min: 0,
        max: 1,
        read_only: true,
        has_feedback: false,
        keep_history: true,
        id: 'f1',
        last_value: 1,
      },
    ],
  };
  const ctx = await setup(t, { config: { zone_kinds: '2:motion' }, devices: [created] });
  await up(ctx);
  const features = ctx.device(zone2.device).features.map((f) => f.external_id.split(':').at(-1));
  assert.ok(features.includes('motion'));
  assert.ok(features.includes('opening'), 'the created feature is kept');
  const kept = ctx.device(zone2.device).features.find((f) => f.external_id.endsWith(':opening'));
  assert.equal(kept.id, undefined);
  assert.equal(kept.last_value, undefined);
});

test('the access code never reaches the logs', async (t) => {
  const ctx = await setup(t, {
    config: { access_code: '908172', allow_disarm: true },
    panel: { code: '908172' },
  });
  await up(ctx);
  await ctx.press(ctx.partition(1), 'arm-away');
  assert.ok(ctx.logger.lines.length > 5);
  assert.ok(!ctx.logger.lines.some((line) => line.includes('908172')));
});

/** The panel holds its answer to `wanted` (once) until release() is called. */
const gateOnce = (panel, wanted) => {
  let release;
  const open = new Promise((resolve) => (release = resolve));
  let used = false;
  panel.gate = (text) => {
    if (text !== wanted || used) return undefined;
    used = true;
    return open;
  };
  return () => release();
};

test('B1: an option switched off while the command waits: nothing sent', async (t) => {
  const ctx = await setup(t, { config: { allow_disarm: true } });
  await up(ctx);
  ctx.panel.partitions[1].status = 'A-E-----';
  const release = gateOnce(ctx.panel, 'PSTT1?');
  const pending = ctx.press(ctx.partition(1), 'disarm');
  await until(() => ctx.panel.requests.includes('PSTT1?'));
  await ctx.gladys.fake.configUpdated({ ...BASE, allow_disarm: false });
  release();
  const ack = await pending;
  assert.equal(ack.success, false);
  assert.match(ack.error, /Disarming from Gladys is disabled.*nothing was sent/);
  assert.deepEqual(ctx.panel.commands, []);
});

test('B1: the option is read again for a command queued behind another', async (t) => {
  const ctx = await setup(t, { config: { allow_bypass: true } });
  await up(ctx);
  const release = gateOnce(ctx.panel, 'ZSTT*1?');
  const first = ctx.press(ctx.zone(1), 'bypass');
  const second = ctx.press(ctx.zone(2), 'bypass');
  await until(() => ctx.panel.requests.includes('ZSTT*1?'));
  await ctx.gladys.fake.configUpdated({ ...BASE, allow_bypass: false });
  release();
  assert.equal((await first).success, false);
  assert.equal((await second).success, false);
  assert.deepEqual(ctx.panel.commands, []);
});

test('I1: an answer that is neither ACK nor an error: sent, not confirmed, guarded', async (t) => {
  const ctx = await setup(t, { config: { allow_bypass: true } });
  await up(ctx);
  ctx.panel.reply = (text) => (text === 'ZBYPAS=2' ? 'ZBYPAS=2' : undefined);
  const ack = await ctx.press(ctx.zone(2), 'bypass');
  assert.equal(ack.success, false);
  assert.match(ack.error, /Sent to the panel .*without confirmation/);
  const again = await ctx.press(ctx.zone(2), 'bypass');
  assert.equal(again.success, false);
  assert.match(again.error, /not confirmed yet/);
  assert.deepEqual(ctx.panel.commands, ['ZBYPAS=2'], 'the second press sent nothing');
});

test('I1: the same rule for ARM: an echo is "sent, not confirmed", never refused', async (t) => {
  const ctx = await setup(t);
  await up(ctx);
  ctx.panel.reply = (text) => (text === 'ARM=1' ? 'ARM=1' : undefined);
  const ack = await ctx.press(ctx.partition(1), 'arm-away');
  assert.match(ack.error, /without confirmation/);
  assert.doesNotMatch(ack.error, /refused/);
});

test('I2: an error without id after a timeout is ambiguous: sent, guarded', async (t) => {
  const ctx = await setup(t, { config: { allow_bypass: true } });
  await up(ctx);
  const client = ctx.app.client;
  ctx.panel.reply = (text) => {
    if (text !== 'ZBYPAS=2') return undefined;
    // An earlier request timed out: the line is uncertain when N05 comes.
    client.uncertain = true;
    const body = Buffer.from('N05\x17');
    ctx.panel.current.raw(
      Buffer.concat([Buffer.from([2]), body, Buffer.from(crc(body)), Buffer.from([3])]),
    );
    return null;
  };
  const ack = await ctx.press(ctx.zone(2), 'bypass');
  assert.equal(ack.success, false);
  assert.match(ack.error, /without confirmation/);
  const again = await ctx.press(ctx.zone(2), 'bypass');
  assert.match(again.error, /not confirmed yet/, 'the guard is set');
  assert.deepEqual(ctx.panel.commands, ['ZBYPAS=2']);
});

test('I3: "Test the connection" during the discovery opens no second socket', async (t) => {
  const ctx = await setup(t);
  const release = gateOnce(ctx.panel, 'ZTYPE*10?');
  await until(() => ctx.panel.requests.includes('ZTYPE*10?'));
  const pending = ctx.gladys.fake.action('test_connection');
  await settle();
  assert.equal(ctx.panel.sockets.length, 1);
  assert.equal(ctx.app.client.progress.zone, 10);
  release();
  const ack = await pending;
  assert.equal(ack.success, true, ack.error);
  assert.equal(ctx.panel.sockets.length, 1);
});

test('M2: a status read stuck behind the line is withdrawn in time: nothing sent', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const ctx = await setup(t);
  await up(ctx);
  ctx.panel.hold = (text) => text === 'PSTT2?';
  const reads = ctx.panel.requests.filter((r) => r === 'PSTT1?').length;
  const busy = ctx.app.client.readPartition(2, { timeout: 60_000 }).catch(() => undefined);
  const pending = ctx.press(ctx.partition(1), 'arm-away');
  await settle();
  t.mock.timers.tick(TIMINGS.sendBy);
  const ack = await pending;
  assert.equal(ack.success, false);
  assert.match(ack.error, /nothing was sent/);
  assert.equal(
    ctx.panel.requests.filter((r) => r === 'PSTT1?').length,
    reads,
    'the read never left',
  );
  assert.deepEqual(ctx.panel.commands, []);
  ctx.app.stop({ final: true });
  await busy;
});

test('M3: a scene action without partition or mode is refused, never guessed', async (t) => {
  const ctx = await setup(t, { config: { allow_disarm: true } });
  await up(ctx);
  assert.equal((await ctx.gladys.fake.sceneAction('arm', { mode: 'armed_away' })).success, false);
  assert.equal((await ctx.gladys.fake.sceneAction('arm', { partition: '1' })).success, false);
  assert.equal((await ctx.gladys.fake.sceneAction('disarm', {})).success, false);
  assert.deepEqual(ctx.panel.commands, []);
});

test('M4: unknown objects are ignored, a burst is published once', async (t) => {
  const ctx = await setup(t);
  await up(ctx);
  const posts = () =>
    ctx.gladys.fake.requests.filter((r) => r.method === 'POST' && /state/.test(r.path)).length;
  const before = posts();
  for (let i = 0; i < 40; i += 1) ctx.panel.push(`ZSTT1=${i % 2 ? 'O' : '-'}-------`);
  ctx.panel.push('ZSTT44=O-------');
  ctx.panel.push('PSTT9=A-E-----');
  await settle(40);
  assert.ok(posts() - before <= 2, `${posts() - before} publications for the burst`);
  assert.equal(ctx.app.model.zones.has(44), false);
  assert.equal(ctx.app.model.partitions.has(9), false);
});

test('M10: a Gladys command credits one transition only', async (t) => {
  const ctx = await setup(t);
  await up(ctx);
  await ctx.press(ctx.partition(1), 'arm-away');
  await settle();
  assert.equal(ctx.events().at(-1).data.by_gladys, true);
  ctx.panel.push('PSTT1=--E-R---');
  ctx.panel.push('PSTT1=A-E-----');
  await settle();
  assert.deepEqual(ctx.events().at(-1).data, {
    partition: '1',
    mode: 'armed_away',
    by_gladys: false,
  });
});

test('M9: overlapping starts leave one sweeper', async (t) => {
  const active = new Set();
  const timers = {
    setTimeout: (...a) => setTimeout(...a),
    clearTimeout: (x) => clearTimeout(x),
    setInterval: (fn, ms) => {
      const id = setInterval(fn, ms);
      if (ms === TIMINGS.sweep) active.add(id);
      return id;
    },
    clearInterval: (id) => {
      active.delete(id);
      clearInterval(id);
    },
  };
  const gladys = createFakeGladys({ config: BASE });
  const panel = new FakeRisco();
  const app = new RiscoApp({
    gladys,
    logger: quietLogger(),
    connect: panel.connect,
    store: memoryStore(),
    timers,
  });
  t.after(() => app.stop({ final: true }));
  await Promise.all([
    app.start(BASE),
    app.start({ ...BASE, access_code: '1234' }),
    app.start(BASE),
  ]);
  assert.equal(active.size, 1);
  app.stop({ final: true });
  assert.equal(active.size, 0);
});

test('R13: the model follows the client in emission order, Gladys queue busy or not', async (t) => {
  const { EventEmitter } = await import('node:events');
  class FakeClient extends EventEmitter {
    constructor() {
      super();
      this.connected = false;
      this.busy = false;
    }
    configure() {}
    start() {}
    stop() {}
  }
  const client = new FakeClient();
  const gladys = createFakeGladys({ config: BASE });
  const app = new RiscoApp({ gladys, logger: quietLogger(), client, store: memoryStore() });
  registerHandlers(gladys, app, quietLogger());
  await gladys.connect();
  t.after(() => app.stop({ final: true }));
  await settle();
  // A first session, so that later transitions fire events.
  const snapshot = (status) => ({
    panel: { model: 'LightSYS', type: 'RP432', zones: 50, partitions: 4 },
    zones: {},
    partitions: { 1: { id: 1, status, label: 'Maison' } },
    system: { label: 'x', status: '--------' },
  });
  client.emit('up', { snapshot: snapshot('--E-R---') });
  await settle();
  // Gladys' queue is busy (a slow publication)…
  let release;
  app.guard(() => new Promise((resolve) => (release = resolve)));
  await settle();
  assert.equal(typeof release, 'function', 'the queue is busy');
  // …while the session drops, comes back, and the panel says "armed stay".
  client.emit('down', { reason: 'x', retryIn: 10_000 });
  client.emit('up', { snapshot: snapshot('--E-R---') });
  client.emit('partition', { id: 1, status: 'H-E-----' });
  client.emit('partition', { id: 1, status: '--E-R---' });
  client.emit('partition', { id: 1, status: 'A-E-----' });
  assert.equal(app.model.partitions.get(1).status, 'A-E-----', 'applied at once, in order');
  assert.equal(app.online, true);
  release();
  await settle(40);
  assert.equal(app.model.partitions.get(1).status, 'A-E-----', 'never overwritten by the up');
  assert.deepEqual(
    gladys.fake.sceneEvents.map((e) => [e.key, e.data.mode]),
    [
      ['armed', 'armed_stay'],
      ['disarmed', undefined],
      ['armed', 'armed_away'],
    ],
  );
  assert.equal(
    gladys.fake.lastState(gladys.externalIds('partition', '1').feature('mode')),
    'Armed (away)',
  );
});

test('R13: a status read is applied at its answer, before a later panel message', async (t) => {
  const ctx = await setup(t);
  await up(ctx);
  ctx.panel.reply = (text, id) => {
    if (text !== 'PSTT1?') return undefined;
    // The panel answers the read (still disarmed), then reports the keypad arming.
    ctx.panel.current.send(id, 'PSTT1=--E-R---');
    ctx.panel.push('PSTT1=H-E-----');
    return null;
  };
  await ctx.app.client.readPartition(1);
  await settle();
  assert.equal(ctx.app.model.partitions.get(1).status, 'H-E-----');
  assert.equal(ctx.state(ctx.partition(1).feature('mode')), 'Armed (stay)');
});

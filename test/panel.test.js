// The panel capabilities and the status letters (pyrisco's), and the configuration.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig, parseHost, parseZoneKinds, sessionKey } from '../src/config.js';
import {
  capabilities,
  isLegacy,
  partitionStatus,
  systemStatus,
  zonePartitions,
  zoneStatus,
} from '../src/risco/panel.js';

test('panel capabilities, as pyrisco gives them', () => {
  assert.deepEqual(capabilities('RW132:01'), {
    type: 'RW132',
    firmware: '',
    model: 'Agility',
    zones: 36,
    partitions: 3,
  });
  assert.equal(capabilities('RP432', '2.9.1').zones, 32);
  assert.equal(capabilities('RP432', '3.0.0 build 12').zones, 50);
  assert.equal(capabilities('RP432MP').zones, 512);
  assert.equal(capabilities('RP512', '1.2.0.6').zones, 64);
  assert.equal(capabilities('RP512', '1.2.0.7').zones, 128);
  assert.equal(capabilities('RP512', '2').zones, 128);
  assert.equal(
    capabilities('RP512', 'garbage').zones,
    64,
    'a firmware not understood is the old one',
  );
  assert.equal(capabilities('XX999'), undefined);
  assert.equal(isLegacy('RW232'), true);
  assert.equal(isLegacy('RP432'), false);
});

test('partition status letters', () => {
  assert.deepEqual(partitionStatus('--E-R---'), {
    exists: true,
    mode: 'disarmed',
    alarm: false,
    ready: true,
    groups: [],
  });
  assert.equal(partitionStatus('A-E-----').mode, 'armed_away');
  assert.equal(partitionStatus('H-E-----').mode, 'armed_stay');
  assert.equal(partitionStatus('--E--2--').mode, 'armed_group');
  assert.equal(partitionStatus('A-E-a---').alarm, true);
  assert.equal(partitionStatus('--------').exists, false);
});

test('zone and system status letters', () => {
  assert.deepEqual(zoneStatus('O--Y-b-a'), {
    used: true,
    open: true,
    alarm: true,
    armed: false,
    bypassed: true,
    batteryLow: true,
  });
  assert.equal(zoneStatus('-------N').used, false);
  assert.equal(zoneStatus('').used, false);
  assert.deepEqual(systemStatus('B-A--X--'), {
    batteryLow: true,
    acTrouble: true,
    tamper: true,
    phoneLine: false,
    clock: false,
    programming: false,
  });
  assert.deepEqual(zonePartitions('5'), [1, 3]);
  assert.deepEqual(zonePartitions('01'), [5]);
  assert.deepEqual(zonePartitions(' '), []);
});

test('configuration: address, port, code, zone kinds', () => {
  assert.deepEqual(parseHost('tcp://192.168.1.50:1001/x'), { host: '192.168.1.50', port: 1001 });
  assert.deepEqual(parseHost('[fe80::1]'), { host: 'fe80::1', port: undefined });
  const config = normalizeConfig({
    host: '192.168.1.50',
    access_code: ' 5678 ',
    zone_kinds: '2:motion, 5=smoke; 7-9:leak, 10:door, x',
  });
  assert.equal(config.port, 1000);
  assert.equal(config.code, '5678');
  assert.equal(config.allowArm, true);
  assert.equal(config.allowDisarm, false, 'disarming is opt-in');
  assert.equal(config.allowBypass, false, 'bypassing is opt-in');
  assert.equal(config.zoneKinds.get(2), 'motion');
  assert.equal(config.zoneKinds.get(5), 'smoke');
  assert.equal(config.zoneKinds.get(8), 'leak');
  assert.deepEqual(config.zoneErrors, ['10:door', 'x']);
  const bad = normalizeConfig({ host: 'x', access_code: '12a4' });
  assert.equal(bad.code, '');
  assert.equal(bad.codeInvalid, true);
  assert.equal(normalizeConfig({ allow_disarm: 'true' }).allowDisarm, false, 'only a real true');
  assert.notEqual(sessionKey(config), sessionKey({ ...config, code: '1111' }));
  assert.equal(parseZoneKinds('600:motion').errors.length, 1);
});

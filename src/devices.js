// -----------------------------------------------------------------------------
// The panel model -> Gladys devices and states (pure).
//
// Ids that do not depend on the panel address (a new DHCP lease keeps the
// devices) and that the panel itself numbers; one panel per integration:
// - `ext:<selector>:panel:risco`: link, mains, battery, tamper;
// - `ext:<selector>:partition:<n>`: state (read-only text), alarm in
//   progress, ready to arm, and the arm away / arm stay / disarm BUTTONS;
// - `ext:<selector>:zone:<n>`: one state feature keyed by the zone kind
//   (`:opening`, `:motion`, `:smoke` or `:leak`), alarm, bypassed, battery
//   low, and the bypass / unbypass BUTTONS.
//
// No command is a switch or a binary: a "turn everything off" (voice
// assistants, HomeKit, scenes on switches) must never reach the alarm. The
// states are read-only, the commands are push buttons.
//
// A device published again never loses a feature the user created (Gladys
// would mark it changed, and "Update" would drop its history): the features
// of the created device that the panel no longer gives are kept.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
} from '@gladysassistant/integration-sdk';
import { OPENING_SENSOR_STATE } from './constants.js';
import { DEVICE_NAMES, FEATURE_NAMES, MODE_NAMES, word } from './i18n.js';
import { partitionStatus, systemStatus, zoneStatus } from './risco/panel.js';

const binary = (category, type) => ({
  category,
  type,
  min: 0,
  max: 1,
  read_only: true,
  has_feedback: false,
  keep_history: true,
});

const button = {
  category: C.BUTTON,
  type: T.BUTTON.PUSH,
  min: 0,
  max: 1,
  read_only: false,
  has_feedback: false,
  keep_history: false,
};

/** Feature definitions by key (the last part of their external id). Keys are forever. */
export const PANEL_FEATURES = {
  online: binary(C.INPUT, T.INPUT.BINARY),
  'ac-power': binary(C.INPUT, T.INPUT.BINARY),
  'battery-low': binary(C.BATTERY_LOW, T.BATTERY_LOW.BINARY),
  tamper: binary(C.TAMPER, T.TAMPER.BINARY),
};

export const PARTITION_FEATURES = {
  mode: {
    category: C.TEXT,
    type: T.TEXT.TEXT,
    min: 0,
    max: 0,
    read_only: true,
    has_feedback: false,
    // A text history is not charted; the armed / disarmed events are the history.
    keep_history: false,
  },
  alarm: binary(C.SIREN, T.SIREN.BINARY),
  ready: binary(C.INPUT, T.INPUT.BINARY),
  'arm-away': button,
  'arm-stay': button,
  disarm: button,
};

/** The state feature of a zone, by kind (the kind is also its feature key). */
export const ZONE_STATE = {
  opening: binary(C.OPENING_SENSOR, T.SENSOR.BINARY),
  motion: binary(C.MOTION_SENSOR, T.SENSOR.BINARY),
  smoke: binary(C.SMOKE_SENSOR, T.SENSOR.BINARY),
  leak: binary(C.LEAK_SENSOR, T.SENSOR.BINARY),
};

export const ZONE_FEATURES = {
  alarm: binary(C.SIREN, T.SIREN.BINARY),
  bypassed: binary(C.INPUT, T.INPUT.BINARY),
  'battery-low': binary(C.BATTERY_LOW, T.BATTERY_LOW.BINARY),
  bypass: button,
  unbypass: button,
};

const ZONE_FEATURE_NAMES = {
  alarm: 'zone-alarm',
  bypassed: 'bypassed',
  'battery-low': 'zone-battery-low',
  bypass: 'bypass',
  unbypass: 'unbypass',
};

export const ids = {
  panel: (gladys) => gladys.externalIds('panel', 'risco'),
  partition: (gladys, n) => gladys.externalIds('partition', String(n)),
  zone: (gladys, n) => gladys.externalIds('zone', String(n)),
};

/** `ext:sel:partition:2:arm-away` -> { kind: 'partition', number: 2, key: 'arm-away' }. */
export function parseFeatureId(externalId) {
  const match = /:(panel|partition|zone):([a-z0-9]+):([a-z-]+)$/.exec(String(externalId ?? ''));
  if (!match) return undefined;
  return {
    kind: match[1],
    number: match[1] === 'panel' ? undefined : Number(match[2]),
    key: match[3],
  };
}

const feature = (deviceIds, key, name, definition) => ({
  name,
  external_id: deviceIds.feature(key),
  ...definition,
});

const sorted = (map) => [...map.entries()].sort(([a], [b]) => a - b);

/** The kind of a zone: the configured one, else an opening. */
export const zoneKind = (config, n) => config.zoneKinds.get(n) ?? 'opening';

/** What a discovered feature declares (a created one also has ids, values, dates). */
const FEATURE_FIELDS = [
  'name',
  'external_id',
  'category',
  'type',
  'min',
  'max',
  'read_only',
  'has_feedback',
  'keep_history',
  'unit',
];

/** Adds to each device the features of its created twin it no longer has. */
export function keepCreatedFeatures(devices, created = []) {
  const byId = new Map((created ?? []).map((device) => [device.external_id, device]));
  return devices.map((device) => {
    const twin = byId.get(device.external_id);
    if (!twin?.features?.length) return device;
    const have = new Set(device.features.map((f) => f.external_id));
    const kept = twin.features
      .filter((f) => f?.external_id && !have.has(f.external_id))
      .map((f) =>
        Object.fromEntries(
          FEATURE_FIELDS.filter((key) => f[key] !== undefined && f[key] !== null).map((key) => [
            key,
            f[key],
          ]),
        ),
      );
    return kept.length === 0 ? device : { ...device, features: [...device.features, ...kept] };
  });
}

export function buildDevices(gladys, config, model, created = gladys.devices) {
  const { language } = config;
  const panel = model.panel ?? {};
  const params = [
    panel.model && { name: 'model', value: panel.model },
    panel.firmware && { name: 'firmware', value: panel.firmware },
  ].filter(Boolean);
  const panelIds = ids.panel(gladys);
  const devices = [
    {
      name: word(DEVICE_NAMES.panel, language),
      external_id: panelIds.device,
      ...(panel.model ? { model: panel.model } : {}),
      should_poll: false,
      params,
      features: Object.entries(PANEL_FEATURES).map(([key, definition]) =>
        feature(panelIds, key, word(FEATURE_NAMES[key], language), definition),
      ),
    },
  ];
  for (const [n, partition] of sorted(model.partitions)) {
    const partitionIds = ids.partition(gladys, n);
    devices.push({
      name: partition.label || word(DEVICE_NAMES.partition, language)(n),
      external_id: partitionIds.device,
      should_poll: false,
      params: [{ name: 'partition', value: String(n) }],
      features: Object.entries(PARTITION_FEATURES).map(([key, definition]) =>
        feature(partitionIds, key, word(FEATURE_NAMES[key], language), definition),
      ),
    });
  }
  for (const [n, zone] of sorted(model.zones)) {
    const zoneIds = ids.zone(gladys, n);
    const kind = zoneKind(config, n);
    devices.push({
      name: zone.label || word(DEVICE_NAMES.zone, language)(n),
      external_id: zoneIds.device,
      should_poll: false,
      params: [
        { name: 'zone', value: String(n) },
        { name: 'kind', value: kind },
        ...(zone.partitions?.length
          ? [{ name: 'partitions', value: zone.partitions.join(',') }]
          : []),
      ],
      features: [
        feature(zoneIds, kind, word(FEATURE_NAMES.kind[kind], language), ZONE_STATE[kind]),
        ...Object.entries(ZONE_FEATURES).map(([key, definition]) =>
          feature(zoneIds, key, word(FEATURE_NAMES[ZONE_FEATURE_NAMES[key]], language), definition),
        ),
      ],
    });
  }
  return keepCreatedFeatures(devices, created);
}

const flag = (value) => (value ? 1 : 0);

/** Every known state: `[{ device_feature_external_id, state | text }]`. */
export function buildStates(gladys, config, model, { online }) {
  const states = [];
  const push = (deviceIds, key, value) => {
    if (value === undefined) return;
    states.push({
      device_feature_external_id: deviceIds.feature(key),
      ...(typeof value === 'string' ? { text: value } : { state: value }),
    });
  };
  const panel = ids.panel(gladys);
  push(panel, 'online', flag(online));
  if (model.system?.status !== undefined) {
    const system = systemStatus(model.system.status);
    push(panel, 'ac-power', flag(!system.acTrouble));
    push(panel, 'battery-low', flag(system.batteryLow));
    push(panel, 'tamper', flag(system.tamper));
  }
  for (const [n, partition] of sorted(model.partitions)) {
    const status = partitionStatus(partition.status);
    const partitionIds = ids.partition(gladys, n);
    push(partitionIds, 'mode', word(MODE_NAMES[status.mode], config.language));
    push(partitionIds, 'alarm', flag(status.alarm));
    push(partitionIds, 'ready', flag(status.ready));
  }
  for (const [n, zone] of sorted(model.zones)) {
    const status = zoneStatus(zone.status);
    const zoneIds = ids.zone(gladys, n);
    const kind = zoneKind(config, n);
    push(
      zoneIds,
      kind,
      kind === 'opening'
        ? status.open
          ? OPENING_SENSOR_STATE.OPEN
          : OPENING_SENSOR_STATE.CLOSE
        : flag(status.open),
    );
    push(zoneIds, 'alarm', flag(status.alarm));
    push(zoneIds, 'bypassed', flag(status.bypassed));
    push(zoneIds, 'battery-low', flag(status.batteryLow));
  }
  return states;
}

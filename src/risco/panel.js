// -----------------------------------------------------------------------------
// What the panel answers, read: the capabilities of each panel type and the
// letters of the status strings. Ported from pyrisco (pyrisco/local/panels.py,
// partition.py, zone.py, system.py; MIT, see THIRD_PARTY_NOTICES.md). Only
// the letters pyrisco documents are read; any other letter is ignored.
// -----------------------------------------------------------------------------

/** `major.minor.patch.build` -> numbers; a part that is not a number is 0. */
const versionParts = (firmware) =>
  String(firmware ?? '')
    .split('.')
    .map((part) => Number.parseInt(part, 10))
    .map((part) => (Number.isFinite(part) ? part : 0));

const atLeast = (parts, wanted) => {
  for (let i = 0; i < wanted.length; i += 1) {
    const part = parts[i] ?? 0;
    if (part !== wanted[i]) return part > wanted[i];
  }
  return true;
};

const PANELS = {
  RW032: () => ({ model: 'Agility 4', zones: 32, partitions: 3 }),
  RW132: () => ({ model: 'Agility', zones: 36, partitions: 3 }),
  RW232: () => ({ model: 'WiComm', zones: 36, partitions: 3 }),
  RW332: () => ({ model: 'WiCommPro', zones: 36, partitions: 3 }),
  RP432: (fw) => ({
    model: 'LightSYS',
    zones: versionParts(fw)[0] >= 3 ? 50 : 32,
    partitions: 4,
  }),
  RP432MP: () => ({ model: 'LightSYS+', zones: 512, partitions: 32 }),
  RW432MPV: () => ({ model: 'LightSYS Air', zones: 128, partitions: 32 }),
  RP512: (fw) => ({
    model: 'ProSYS Plus / GT Plus',
    zones: atLeast(versionParts(fw), [1, 2, 0, 7]) ? 128 : 64,
    partitions: 32,
  }),
};

export const PANEL_TYPES = Object.keys(PANELS);

/**
 * The answer to `PNLCNF` (and `FSVER?`) -> { type, model, zones, partitions,
 * firmware }, or undefined for a type pyrisco does not know.
 */
export function capabilities(panelType, firmware = '') {
  const type = String(panelType ?? '')
    .trim()
    .split(':')[0];
  const make = PANELS[type];
  if (!make) return undefined;
  const fw = String(firmware ?? '')
    .trim()
    .split(' ')[0];
  return { type, firmware: fw, ...make(fw) };
}

/** Agility and WiComm (types not starting with RP) know neither FSVER?, ZLNKTYP nor ZAREA. */
export const isLegacy = (panelType) => !String(panelType ?? '').startsWith('RP');

/** A partition status string (`PSTT1?`). */
export function partitionStatus(status) {
  const s = String(status ?? '');
  const groups = ['1', '2', '3', '4'].filter((g) => s.includes(g)).map(Number);
  const armed = s.includes('A');
  const stay = s.includes('H');
  let mode = 'disarmed';
  if (armed) mode = 'armed_away';
  else if (stay) mode = 'armed_stay';
  else if (groups.length > 0) mode = 'armed_group';
  return {
    exists: s.includes('E'),
    mode,
    alarm: s.includes('a'),
    ready: s.includes('R'),
    groups,
  };
}

/** A zone status string (`ZSTT*5?`). A status ending with N: the zone is not in use. */
export function zoneStatus(status) {
  const s = String(status ?? '');
  return {
    used: s !== '' && !s.endsWith('N'),
    open: s.includes('O'),
    alarm: s.includes('a'),
    armed: s.includes('A'),
    bypassed: s.includes('Y'),
    batteryLow: s.includes('b'),
  };
}

/** The system status string (`SSTT?`). */
export function systemStatus(status) {
  const s = String(status ?? '');
  return {
    batteryLow: s.includes('B'),
    acTrouble: s.includes('A'),
    tamper: s.includes('X'),
    phoneLine: s.includes('P'),
    clock: s.includes('C'),
    programming: s.includes('I'),
  };
}

/**
 * The partitions of a zone (`ZPART&*5?`): one hex digit per 4 partitions,
 * lowest bit first -> [1, 3, …].
 */
export function zonePartitions(value) {
  const partitions = [];
  [...String(value ?? '').trim()].forEach((digit, index) => {
    const bits = Number.parseInt(digit, 16);
    if (!Number.isFinite(bits)) return;
    for (let bit = 0; bit < 4; bit += 1) {
      if (bits & (1 << bit)) partitions.push(index * 4 + bit + 1);
    }
  });
  return partitions;
}

// -----------------------------------------------------------------------------
// The configuration of the manifest `config_schema`, normalized.
// -----------------------------------------------------------------------------

import { DEFAULT_PORT, LIMITS, ZONE_KINDS } from './constants.js';

/** Defaults, mirrored by the manifest (checked by test/manifest.test.js). */
export const DEFAULTS = {
  port: DEFAULT_PORT,
  allow_arm: true,
  allow_disarm: false,
  allow_bypass: false,
  language: 'fr',
};

export const LANGUAGES = ['fr', 'en'];

const bool = (value, fallback) => (typeof value === 'boolean' ? value : fallback);

const integer = (value, fallback, min, max) => {
  const number = Number(value);
  return value !== null && value !== '' && value !== undefined && Number.isFinite(number)
    ? Math.round(Math.max(min, Math.min(max, number)))
    : fallback;
};

/** `192.168.1.40`, `risco.lan:1000`, `tcp://192.168.1.40` -> { host, port? }. */
export function parseHost(raw) {
  let text = String(raw ?? '').trim();
  text = text.replace(/^[a-z]+:\/\//i, '').replace(/\/.*$/, '');
  const match = /^(\[[0-9a-f:.]+\]|[^:\s]+)(?::(\d{1,5}))?$/i.exec(text);
  if (!match) return { host: '' };
  const port = match[2] ? Number(match[2]) : undefined;
  return {
    host: match[1].replace(/^\[|\]$/g, ''),
    port: port >= 1 && port <= 65535 ? port : undefined,
  };
}

/** The access code of the panel: 4 to 8 digits, '' when absent or malformed. */
export const normalizeCode = (raw) => {
  const text = String(raw ?? '').trim();
  return /^\d{4,8}$/.test(text) ? text : '';
};

/**
 * How the zones show: `3:motion, 5:smoke, 10-12:motion` -> Map(zone -> kind).
 * Entries are separated by commas, semicolons or new lines; `=` works like
 * `:`. Wrong entries are reported, not fatal. A zone not listed is an opening.
 */
export function parseZoneKinds(raw) {
  const kinds = new Map();
  const errors = [];
  for (const entry of String(raw ?? '').split(/[,;\n]+/)) {
    const text = entry.trim();
    if (text === '') continue;
    const match = /^(\d{1,3})(?:\s*-\s*(\d{1,3}))?\s*[:=]\s*([a-z]+)$/i.exec(text);
    const kind = match?.[3].toLowerCase();
    const from = Number(match?.[1]);
    const to = match?.[2] ? Number(match[2]) : from;
    if (!match || !ZONE_KINDS.includes(kind) || from < 1 || to > LIMITS.maxZones || to < from) {
      errors.push(text);
      continue;
    }
    for (let zone = from; zone <= to; zone += 1) kinds.set(zone, kind);
  }
  return { kinds, errors };
}

export function normalizeConfig(raw = {}) {
  const { host, port: hostPort } = parseHost(raw?.host);
  const language = String(raw?.language ?? DEFAULTS.language)
    .trim()
    .toLowerCase();
  const typedCode = String(raw?.access_code ?? '').trim();
  const zones = parseZoneKinds(raw?.zone_kinds);
  return {
    host,
    // A port typed with the address wins over the port field (which has a default).
    port: hostPort ?? integer(raw?.port, DEFAULTS.port, 1, 65535),
    code: normalizeCode(typedCode),
    codeInvalid: typedCode !== '' && normalizeCode(typedCode) === '',
    zoneKinds: zones.kinds,
    zoneErrors: zones.errors,
    allowArm: bool(raw?.allow_arm, DEFAULTS.allow_arm),
    allowDisarm: bool(raw?.allow_disarm, DEFAULTS.allow_disarm),
    allowBypass: bool(raw?.allow_bypass, DEFAULTS.allow_bypass),
    language: LANGUAGES.includes(language) ? language : DEFAULTS.language,
  };
}

/** What the session depends on: a change reconnects (and lifts a stop on a refused code). */
export const sessionKey = (config) => JSON.stringify([config.host, config.port, config.code]);

/** Where the session goes, without the code: what a persisted stop is tied to. */
export const placeKey = (config) => `${config.host}:${config.port}`;

// -----------------------------------------------------------------------------
// The integration: one local session with the Risco panel (src/risco/client.js),
// the panel model it describes, the Gladys devices and states
// (src/devices.js), the scene events, the commands. index.js only wires the
// SDK handlers to it.
//
// Safety:
// - arming is allowed unless the configuration forbids it; disarming and
//   bypassing a zone are off unless the configuration allows them;
// - a command decides on the state read from the panel right before it,
//   never on the state in memory; one command at a time;
// - a command is sent within 3.5 s of the request or not at all (Gladys
//   waits 5 s); one that may have reached the panel is never reported "not
//   sent", but "sent, not confirmed", and the state is read again;
// - a bypass is a toggle on the panel: after one is sent, the zone takes no
//   other until the panel shows the bypass asked or 30 s passed;
// - every command, sent or refused, is logged; the access code never is.
// -----------------------------------------------------------------------------

import { DEVICE_TRANSPORTS, createLogger } from '@gladysassistant/integration-sdk';
import { normalizeConfig, placeKey, sessionKey } from './config.js';
import { ARM_MODES, BUTTON_PUSH, LIMITS, SCENE_TRIGGERS, TIMINGS } from './constants.js';
import { buildDevices, buildStates, parseFeatureId } from './devices.js';
import { COMMAND_NAMES, T, fill, word } from './i18n.js';
import { RiscoClient, RiscoError } from './risco/client.js';
import { partitionStatus, zoneStatus } from './risco/panel.js';
import { StatePublisher } from './publisher.js';
import { fileStore, normalizeMemory } from './store.js';

/** A command refused before anything was sent to the panel. */
export class Refused extends Error {}

/** Command -> [config flag, refusal message, log name]. */
const OPTIONS = {
  arm: ['allowArm', T.armRefused, 'Arm'],
  disarm: ['allowDisarm', T.disarmRefused, 'Disarm'],
  bypass: ['allowBypass', T.bypassRefused, 'Bypass'],
};

const emptyModel = () => ({
  panel: undefined,
  partitions: new Map(),
  zones: new Map(),
  system: undefined,
});

export class RiscoApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'risco' }),
    client,
    connect,
    now = Date.now,
    timers = globalThis,
    store = fileStore(),
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.now = now;
    this.timers = timers;
    this.store = store;
    this.client = client ?? new RiscoClient({ connect, timers, now, logger });
    this.publisher = new StatePublisher({ gladys, logger, now, timers });
    this.config = normalizeConfig();
    this.key = undefined;
    this.model = emptyModel();
    this.online = false;
    this.memory = undefined;
    /** partition -> { mode, until }: what the last Gladys command asked. */
    this.commanded = new Map();
    /** zone -> { expected, until }: a bypass sent, not seen yet. */
    this.bypassGuards = new Map();
    this.readBacks = new Set();
    this.lastStatus = undefined;
    this.lastTransport = undefined;
    this.published = undefined;
    this.started = false;
    this.sweeper = undefined;
    this.commands = Promise.resolve();
    this.starting = Promise.resolve();
    this.pendingEvents = [];
    this.flushScheduled = false;
    // Every model change is applied when the client emits it, in the order of
    // emission (session up, messages, read results, session down); guard()
    // only queues what talks to Gladys (publication, scene events, status).
    this.client.on('up', (info) => {
      const events = this.applyUp(info);
      this.guard(() => this.onUp(events));
    });
    this.client.on('down', (info) => {
      const wasOnline = this.online;
      this.online = false;
      this.guard(() => this.onDown(info, wasOnline));
    });
    this.client.on('partition', ({ id, status }) =>
      this.noteChange(() => this.applyPartition(id, status)),
    );
    this.client.on('zone', ({ id, status }) => this.noteChange(() => this.applyZone(id, status)));
    this.client.on('system', ({ status }) =>
      this.noteChange(() => {
        if (!this.model.panel) return null;
        this.model.system = { ...this.model.system, status };
        return [];
      }),
    );
  }

  /** Client events run one after the other, in order. */
  guard(fn) {
    this.chain = (this.chain ?? Promise.resolve())
      .then(fn)
      .catch((err) => this.logger.error(`Risco event failed: ${err.message}`));
    return this.chain;
  }

  get language() {
    return this.config.language;
  }

  error(entry, cause) {
    return new Error(word(entry, this.language), cause ? { cause } : undefined);
  }

  refused(entry) {
    return new Refused(word(entry, this.language));
  }

  // --- Lifecycle -------------------------------------------------------------

  async loadMemory() {
    if (this.memory) return this.memory;
    try {
      this.memory = normalizeMemory(await this.store.load());
    } catch {
      this.memory = normalizeMemory(null);
    }
    return this.memory;
  }

  async saveMemory() {
    try {
      await this.store.save(this.memory);
    } catch (err) {
      this.logger.warn(`Saving the state to /data failed: ${err.message}`);
    }
  }

  /** Starts (or restarts); two starts never overlap (no leaked timer). */
  start(raw = {}) {
    const run = this.starting.then(() => this.startNow(raw));
    this.starting = run.catch(() => undefined);
    return run;
  }

  async startNow(raw = {}) {
    this.stop();
    const next = normalizeConfig(raw);
    if (placeKey(next) !== placeKey(this.config)) {
      // Another panel, maybe: what we knew no longer holds.
      this.model = emptyModel();
    }
    this.config = next;
    this.key = sessionKey(next);
    this.online = false;
    if (next.zoneErrors.length > 0) {
      this.logger.warn(`Zone kinds not understood: ${next.zoneErrors.join(', ')}`);
    }
    if (next.codeInvalid) {
      this.logger.warn('The access code of the configuration is not 4 to 8 digits: ignored');
    }
    const memory = await this.loadMemory();
    await this.publishDevices();
    await this.publishStates();
    const problem = this.configProblem();
    if (problem) {
      await this.setStatus(false, problem);
      return;
    }
    if (memory.stop && memory.stop.place === placeKey(next)) {
      this.logger.warn(
        'Risco: the panel refused this access code before: not sent again until the configuration changes or "Test the connection" is clicked',
      );
      await this.setStatus(false, T.refused);
      return;
    }
    await this.setStatus(false, T.connecting);
    this.client.configure({ host: next.host, port: next.port, code: next.code });
    this.client.start();
    this.startSweeper();
  }

  startSweeper() {
    if (this.sweeper) this.timers.clearInterval(this.sweeper);
    this.sweeper = this.timers.setInterval(() => this.guard(() => this.sweep()), TIMINGS.sweep);
  }

  /**
   * Stops the session. `final` only when the container stops: a restart
   * (new address or code) keeps the alarm_triggered retries running.
   */
  stop({ final = false } = {}) {
    this.client.stop();
    this.online = false;
    this.publisher.stop({ final });
    if (this.sweeper) {
      this.timers.clearInterval(this.sweeper);
      this.sweeper = undefined;
    }
    for (const timer of this.readBacks) this.timers.clearTimeout(timer);
    this.readBacks.clear();
  }

  configProblem() {
    if (!this.config.host) return T.noHost;
    if (!this.config.code) return this.config.codeInvalid ? T.badCode : T.noCode;
    return undefined;
  }

  /** First connection to Gladys: start; a reconnection (Gladys restarted): resend everything. */
  async connected(raw = {}) {
    if (!this.started) {
      this.started = true;
      await this.start(raw);
      return;
    }
    // Gladys keeps the connection status and the discovered devices in memory.
    this.published = undefined;
    this.lastTransport = undefined;
    const status = this.lastStatus;
    this.lastStatus = undefined;
    await this.configUpdated(raw);
    if (status && this.lastStatus === undefined) {
      const [connected, message] = JSON.parse(status);
      await this.setStatus(connected, message ?? undefined);
    }
    this.publisher.forget();
    await this.publishDevices();
    await this.publishStates();
    await this.publishTransports(
      this.online ? DEVICE_TRANSPORTS.LOCAL : DEVICE_TRANSPORTS.UNREACHABLE,
    );
  }

  /** A new address, port or code reconnects (and lifts a stop); the rest applies at once. */
  async configUpdated(raw = {}) {
    const next = normalizeConfig(raw);
    if (sessionKey(next) !== this.key) {
      await this.liftStop();
      return this.start(raw);
    }
    this.config = next;
    await this.publishDevices();
    await this.publishStates();
    if (this.online) await this.setStatus(true, this.connectedMessage());
    return undefined;
  }

  async liftStop() {
    const memory = await this.loadMemory();
    if (!memory.stop) return;
    memory.stop = null;
    await this.saveMemory();
  }

  async setStatus(connected, message) {
    const key = JSON.stringify([connected, message ?? null]);
    if (key === this.lastStatus) return;
    this.lastStatus = key;
    await this.gladys
      .setConnectionStatus(connected, message)
      .catch((err) => this.logger.warn(`setConnectionStatus failed: ${err.message}`));
  }

  partitionsSummary() {
    return [...this.model.partitions.entries()]
      .sort(([a], [b]) => a - b)
      .map(([partition, p]) => ({ partition, mode: partitionStatus(p.status).mode }));
  }

  connectedMessage() {
    return fill(
      T.connected,
      this.model.panel?.model ?? 'Risco',
      this.partitionsSummary(),
      this.model.zones.size,
    );
  }

  // --- Client events ---------------------------------------------------------

  /** The model of a new session, applied at once: the events it means. */
  applyUp({ snapshot }) {
    const events = [];
    this.model.panel = snapshot.panel;
    const partitions = new Map();
    for (const p of Object.values(snapshot.partitions)) {
      events.push(...this.transitions(p.id, this.model.partitions.get(p.id)?.status, p.status));
      partitions.set(p.id, { label: p.label, status: p.status });
    }
    this.model.partitions = partitions;
    const zones = new Map();
    for (const z of Object.values(snapshot.zones)) {
      zones.set(z.id, { label: z.label, status: z.status, partitions: z.partitions, type: z.type });
    }
    this.model.zones = zones;
    for (const [id, zone] of zones) this.checkGuard(id, zone.status);
    this.model.system = snapshot.system;
    this.online = true;
    return events;
  }

  /** Gladys side of a new session: devices, states, status, transports, events. */
  async onUp(events) {
    await this.publishDevices();
    await this.publishStates();
    await this.setStatus(true, this.connectedMessage());
    await this.publishTransports(DEVICE_TRANSPORTS.LOCAL);
    for (const event of events) await this.effect(event);
  }

  /** Gladys side of a session lost (the model went offline when it was emitted). */
  async onDown({ reason, retryIn, refused, unsupported, contended }, wasOnline) {
    const seconds = Math.round((retryIn ?? 0) / 1000);
    if (refused) {
      this.logger.error('Risco: access code refused, connection stopped (no new try)');
      const memory = await this.loadMemory();
      memory.stop = { place: placeKey(this.config), kind: 'code_refused', at: this.now() };
      await this.saveMemory();
      await this.setStatus(false, T.refused);
    } else if (unsupported) {
      await this.setStatus(false, T.unsupported);
    } else if (contended) {
      this.logger.warn(
        `Risco: sessions dropped right after they started, several times (another client?); next try in ${seconds} s`,
      );
      await this.setStatus(false, fill(T.contended, seconds));
    } else {
      this.logger.warn(`Risco: ${reason}; next try in ${seconds} s`);
      await this.setStatus(false, fill(T.unreachable, reason, seconds));
    }
    if (wasOnline || this.lastTransport !== undefined) {
      await this.publishStates();
      await this.publishTransports(DEVICE_TRANSPORTS.UNREACHABLE);
    }
  }

  /**
   * A change from the panel, applied to the model at once and in order; an
   * object the panel did not give at the discovery is ignored right here.
   * The publication, the scene events and the status follow once per turn
   * of the event loop, however many messages came in it (a flood costs one
   * publication).
   */
  noteChange(apply) {
    const events = apply();
    if (events === null) return;
    this.pendingEvents.push(...events);
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    setImmediate(() => {
      this.flushScheduled = false;
      this.guard(() => this.flushChanges());
    });
  }

  async flushChanges() {
    const events = this.pendingEvents.splice(0);
    await this.publishStates();
    for (const event of events) await this.effect(event);
    if (this.online) await this.setStatus(true, this.connectedMessage());
  }

  /** A partition status from the panel (pushed or read): the events it means; null if unknown. */
  applyPartition(id, status) {
    const partition = this.model.partitions.get(id);
    if (!partition) return null;
    const events = this.transitions(id, partition.status, status);
    partition.status = status;
    return events;
  }

  applyZone(id, status) {
    const zone = this.model.zones.get(id);
    if (!zone) return null;
    zone.status = status;
    this.checkGuard(id, status);
    return [];
  }

  /** A bypass guard falls when the panel shows the bypass asked. */
  checkGuard(id, status) {
    const guard = this.bypassGuards.get(id);
    if (guard && zoneStatus(status).bypassed === guard.expected) this.bypassGuards.delete(id);
  }

  /** Nothing for the first status seen of a partition after a start. */
  transitions(id, before, after) {
    if (before === undefined || before === after) return [];
    const a = partitionStatus(before);
    const b = partitionStatus(after);
    const events = [];
    if (a.mode !== b.mode) {
      events.push(
        b.mode === 'disarmed'
          ? { type: 'disarmed', partition: id }
          : { type: 'armed', partition: id, mode: b.mode },
      );
    }
    if (!a.alarm && b.alarm) events.push({ type: 'alarm', partition: id });
    return events;
  }

  /** Whether a transition answers a Gladys command; the entry is used once. */
  byGladys(partition, mode) {
    const asked = this.commanded.get(partition);
    const match = Boolean(asked && asked.mode === mode && this.now() < asked.until);
    if (match) this.commanded.delete(partition);
    return match;
  }

  /** The zone in alarm of a partition, if the panel says which. */
  zoneInAlarm(partition) {
    for (const [id, zone] of [...this.model.zones.entries()].sort(([a], [b]) => a - b)) {
      if (zoneStatus(zone.status).alarm && (zone.partitions ?? []).includes(partition)) return id;
    }
    return undefined;
  }

  async effect(event) {
    const partition = String(event.partition);
    if (event.type === 'armed') {
      const byGladys = this.byGladys(event.partition, event.mode);
      this.logger.info(
        `Panel: partition ${partition} ARMED ${event.mode} (${byGladys ? 'Gladys command' : 'keypad or other'})`,
      );
      await this.publisher.sceneEvent(SCENE_TRIGGERS.ARMED, {
        partition,
        mode: event.mode,
        by_gladys: byGladys,
      });
    } else if (event.type === 'disarmed') {
      const byGladys = this.byGladys(event.partition, 'disarmed');
      this.logger.info(
        `Panel: partition ${partition} DISARMED (${byGladys ? 'Gladys command' : 'keypad or other'})`,
      );
      await this.publisher.sceneEvent(SCENE_TRIGGERS.DISARMED, {
        partition,
        by_gladys: byGladys,
      });
    } else if (event.type === 'alarm') {
      const zone = this.zoneInAlarm(event.partition);
      this.logger.warn(`Panel: ALARM partition ${partition}${zone ? ` zone ${zone}` : ''}`);
      await this.publisher.sceneEvent(SCENE_TRIGGERS.ALARM_TRIGGERED, {
        partition,
        zone: zone ?? null,
      });
    }
  }

  /** Heartbeats of the unchanged states; expired guards and memories go. */
  async sweep() {
    const now = this.now();
    for (const [id, guard] of this.bypassGuards)
      if (now >= guard.until) this.bypassGuards.delete(id);
    for (const [id, asked] of this.commanded) if (now >= asked.until) this.commanded.delete(id);
    await this.publishStates();
  }

  // --- Gladys ----------------------------------------------------------------

  devices() {
    // Nothing to show before the panel was read once (its zones come from it).
    if (!this.model.panel) return undefined;
    return buildDevices(this.gladys, this.config, this.model);
  }

  async publishDevices({ force = false } = {}) {
    const devices = this.devices();
    if (!devices) return;
    const json = JSON.stringify(devices);
    if (json === this.published && !force) return;
    try {
      await this.gladys.publishDiscoveredDevices(devices);
      this.published = json;
    } catch (err) {
      this.logger.warn(`Publishing the devices failed: ${err.message}`);
    }
  }

  publishStates() {
    if (!this.model.panel) return Promise.resolve();
    return this.publisher.publish(
      buildStates(this.gladys, this.config, this.model, { online: this.online }),
    );
  }

  async publishTransports(transport) {
    if (transport === this.lastTransport) return;
    const devices = this.devices();
    if (!devices) return;
    const entries = devices.map((device) => ({ external_id: device.external_id, transport }));
    try {
      // At most 100 entries per request.
      for (let i = 0; i < entries.length; i += 100) {
        await this.gladys.publishTransports(entries.slice(i, i + 100));
      }
      this.lastTransport = transport;
    } catch (err) {
      this.logger.warn(`Publishing the transports failed: ${err.message}`);
    }
  }

  async scan() {
    await this.publishDevices({ force: true });
  }

  /** The user created or updated a device: Gladys has none of its states yet, send them again. */
  async deviceChanged(device) {
    this.publisher.forget(device?.external_id);
    await this.publishStates();
  }

  // --- Commands --------------------------------------------------------------

  /** One command at a time; a failed one never blocks the next. */
  serial(fn) {
    const run = this.commands.then(fn, fn);
    this.commands = run.catch(() => undefined);
    return run;
  }

  partitionOf(value) {
    const n = Number(value);
    if (value === null || value === '' || !Number.isInteger(n) || n < 1) {
      throw this.refused(fill(T.unknownPartition, String(value)));
    }
    if (n > LIMITS.maxPartitions) throw this.refused(fill(T.unknownPartition, String(value)));
    return n;
  }

  zoneOf(value) {
    const n = Number(value);
    if (value === null || value === '' || !Number.isInteger(n) || n < 1 || n > LIMITS.maxZones) {
      throw this.refused(fill(T.unknownZone, String(value)));
    }
    return n;
  }

  /** A button pressed in Gladys. Only a push (1) of a button feature acts. */
  async setValue(_device, feature, value) {
    const target = parseFeatureId(feature?.external_id);
    const asked = this.now();
    const pressed = value === BUTTON_PUSH.PRESSED || value === String(BUTTON_PUSH.PRESSED);
    const action = target && `${target.kind}:${target.key}`;
    const handlers = {
      'partition:arm-away': () => this.arm(target.number, 'armed_away', asked),
      'partition:arm-stay': () => this.arm(target.number, 'armed_stay', asked),
      'partition:disarm': () => this.disarm(target.number, asked),
      'zone:bypass': () => this.bypass(target.number, true, asked),
      'zone:unbypass': () => this.bypass(target.number, false, asked),
    };
    if (!handlers[action]) throw new Error(`${feature?.external_id} is read-only`);
    if (!pressed) throw new Error(`Unexpected value ${JSON.stringify(value)} for a button`);
    await handlers[action]();
  }

  /**
   * The status of a partition or zone, read from the panel now; refused (nothing
   * sent) when it cannot be read in time. The read is withdrawn at sendBy if it
   * is still waiting for the line, so the refusal comes within Gladys' 5 s.
   */
  async fresh(read, asked, unknown) {
    if (!this.client.connected) throw this.refused(T.offline);
    const sendBy = asked + TIMINGS.sendBy;
    const left = sendBy - this.now();
    if (left < 200) throw this.refused(T.tooLate);
    const ticket = {};
    const timer = this.timers.setTimeout(() => {
      if (!ticket.written) ticket.cancel?.();
    }, left);
    try {
      return await read({ timeout: Math.min(TIMINGS.readBefore, left), sendBy, ticket });
    } catch (err) {
      if (err instanceof RiscoError && err.kind === 'panel') throw this.refused(unknown);
      if (err instanceof RiscoError && err.kind === 'late') throw this.refused(T.tooLate);
      if (err instanceof RiscoError && err.kind === 'offline') throw this.refused(T.offline);
      // Timeout, ambiguous or unexpected answer, lost session: unreadable.
      throw this.refused(T.stateUnknown);
    } finally {
      this.timers.clearTimeout(timer);
    }
  }

  isAllowed(command) {
    return Boolean(this.config[OPTIONS[command][0]]);
  }

  /** The option of a command, read again now; refused (nothing sent) once switched off. */
  checkAllowed(command, what) {
    const option = OPTIONS[command];
    if (this.isAllowed(command)) return;
    this.logger.warn(`${option[2]} REFUSED (${word(what, 'en')}): disabled in the configuration`);
    throw this.refused(option[1]);
  }

  /**
   * Sends a command decided on a fresh status. Resolves when the panel
   * accepted it; throws Refused when nothing was sent, an Error otherwise.
   * Only an error answer (N.., B..) is a refusal: any other outcome after the
   * write (no answer, another answer, an ambiguous one, a lost session) is
   * "sent, without confirmation", with onSent() and a read back.
   */
  async send(what, asked, run, { command, onSent, readBack }) {
    const label = word(what, 'en');
    if (this.now() > asked + TIMINGS.sendBy) {
      this.logger.warn(`Command NOT sent (${label}): too late`);
      throw this.refused(T.tooLate);
    }
    // The configuration may have changed while the command waited its turn.
    this.checkAllowed(command, what);
    const ticket = {};
    // …and once more by the client, right before the socket write.
    const request = run({
      sendBy: asked + TIMINGS.sendBy,
      ticket,
      check: () => this.isAllowed(command),
    });
    let timer;
    const late = new Promise((resolve) => {
      timer = this.timers.setTimeout(
        () => resolve('late'),
        Math.max(0, asked + TIMINGS.answerBy - this.now()),
      );
    });
    let outcome;
    try {
      outcome = await Promise.race([request.then(() => 'ok'), late]);
    } catch (err) {
      if (err instanceof RiscoError && !err.sent) {
        this.logger.warn(`Command NOT sent (${label}): ${err.message}`);
        if (err.kind === 'withdrawn') this.checkAllowed(command, what);
        throw this.refused(err.kind === 'late' ? T.tooLate : T.offline);
      }
      if (err instanceof RiscoError && err.kind === 'panel') {
        this.logger.warn(`Command REFUSED by the panel (${label}): ${err.code}`);
        this.scheduleReadBack(readBack);
        throw this.error(fill(T.panelRefused, word(what, this.language), err.code));
      }
      this.logger.warn(`Command sent, NOT confirmed (${label}): ${err.message}`);
      onSent();
      this.scheduleReadBack(readBack);
      throw this.error(fill(T.unconfirmed, word(what, this.language)), err);
    } finally {
      this.timers.clearTimeout(timer);
    }
    if (outcome === 'late') {
      if (!ticket.written && ticket.cancel()) {
        this.logger.warn(`Command NOT sent (${label}): the line stayed busy`);
        throw this.refused(T.tooLate);
      }
      onSent();
      request.then(
        () => this.logger.info(`Command confirmed late by the panel (${label})`),
        (err) => this.logger.warn(`Command not confirmed (${label}): ${err.message}`),
      );
      this.scheduleReadBack(readBack);
      this.logger.warn(`Command sent, NOT confirmed in time (${label})`);
      throw this.error(fill(T.unconfirmed, word(what, this.language)));
    }
    onSent();
    this.logger.info(`Command accepted by the panel (${label})`);
    this.scheduleReadBack(readBack);
  }

  scheduleReadBack(readBack) {
    const timer = this.timers.setTimeout(() => {
      this.readBacks.delete(timer);
      if (!this.client.connected) return;
      readBack().catch((err) => this.logger.debug(`Read back failed: ${err.message}`));
    }, TIMINGS.readBack);
    this.readBacks.add(timer);
  }

  // The client emits every status it reads (as a 'partition' or 'zone'
  // event, at the answer, in order with the panel's own messages): a read
  // back only has to ask.
  readBackPartition(n) {
    return () => this.client.readPartition(n);
  }

  readBackZone(n) {
    return () => this.client.readZone(n);
  }

  async arm(rawPartition, mode, asked = this.now()) {
    if (!ARM_MODES.includes(mode)) throw new Error(`Unknown arming mode ${mode}`);
    const n = this.partitionOf(rawPartition);
    const what = fill(COMMAND_NAMES[mode], n);
    this.checkAllowed('arm', what);
    return this.serial(async () => {
      this.checkAllowed('arm', what);
      const raw = await this.fresh(
        (options) => this.client.readPartition(n, options),
        asked,
        fill(T.unknownPartition, n),
      );
      const status = partitionStatus(raw);
      if (!status.exists) throw this.refused(fill(T.unknownPartition, n));
      if (status.mode === mode) {
        this.logger.info(`Partition ${n} already ${mode}: nothing sent`);
        return;
      }
      if (status.mode !== 'disarmed') {
        this.logger.warn(`Arm REFUSED (${word(what, 'en')}): partition ${n} is ${status.mode}`);
        throw this.refused(T.otherMode);
      }
      this.checkAllowed('arm', what);
      this.logger.info(`ARMING from Gladys: ${word(what, 'en')}`);
      await this.send(
        what,
        asked,
        (options) =>
          mode === 'armed_away' ? this.client.arm(n, options) : this.client.armStay(n, options),
        {
          command: 'arm',
          onSent: () => this.commanded.set(n, { mode, until: this.now() + TIMINGS.commandMemory }),
          readBack: this.readBackPartition(n),
        },
      );
    });
  }

  async disarm(rawPartition, asked = this.now()) {
    const n = this.partitionOf(rawPartition);
    const what = fill(COMMAND_NAMES.disarm, n);
    this.checkAllowed('disarm', what);
    return this.serial(async () => {
      this.checkAllowed('disarm', what);
      const raw = await this.fresh(
        (options) => this.client.readPartition(n, options),
        asked,
        fill(T.unknownPartition, n),
      );
      const status = partitionStatus(raw);
      if (!status.exists) throw this.refused(fill(T.unknownPartition, n));
      if (status.mode === 'disarmed' && !status.alarm) {
        this.logger.info(`Partition ${n} already disarmed: nothing sent`);
        return;
      }
      this.checkAllowed('disarm', what);
      this.logger.info(`DISARMING from Gladys: ${word(what, 'en')}`);
      await this.send(what, asked, (options) => this.client.disarm(n, options), {
        command: 'disarm',
        onSent: () =>
          this.commanded.set(n, { mode: 'disarmed', until: this.now() + TIMINGS.commandMemory }),
        readBack: this.readBackPartition(n),
      });
    });
  }

  async bypass(rawZone, wanted, asked = this.now()) {
    const n = this.zoneOf(rawZone);
    const what = fill(COMMAND_NAMES[wanted ? 'bypass' : 'unbypass'], n);
    this.checkAllowed('bypass', what);
    return this.serial(async () => {
      this.checkAllowed('bypass', what);
      const raw = await this.fresh(
        (options) => this.client.readZone(n, options),
        asked,
        fill(T.unknownZone, n),
      );
      const status = zoneStatus(raw);
      if (!status.used) throw this.refused(fill(T.unknownZone, n));
      this.checkGuard(n, raw);
      if (status.bypassed === wanted) {
        this.logger.info(`Zone ${n} already ${wanted ? 'bypassed' : 'not bypassed'}: nothing sent`);
        return;
      }
      const guard = this.bypassGuards.get(n);
      if (guard && this.now() < guard.until) {
        this.logger.warn(`Bypass REFUSED (${word(what, 'en')}): the previous one is not seen yet`);
        throw this.refused(T.bypassPending);
      }
      this.checkAllowed('bypass', what);
      this.logger.info(`BYPASS from Gladys: ${word(what, 'en')}`);
      // ZBYPAS toggles: the guard is set once the request left (accepted or
      // not confirmed), and falls only when the panel shows the bypass asked,
      // or after 30 s.
      await this.send(what, asked, (options) => this.client.toggleBypass(n, options), {
        command: 'bypass',
        onSent: () =>
          this.bypassGuards.set(n, { expected: wanted, until: this.now() + TIMINGS.bypassGuard }),
        readBack: this.readBackZone(n),
      });
    });
  }

  // --- Configuration button ----------------------------------------------------

  /** Waits for the session to come up or go down, at most `timeout` ms. */
  waitForLink(timeout = TIMINGS.testWait) {
    if (this.client.connected) return Promise.resolve('up');
    return new Promise((resolve) => {
      const done = (result) => {
        this.client.off('up', onUp);
        this.client.off('down', onDown);
        this.timers.clearTimeout(timer);
        resolve(result);
      };
      const onUp = () => done('up');
      const onDown = () => done('down');
      const timer = this.timers.setTimeout(() => done('timeout'), timeout);
      this.client.on('up', onUp);
      this.client.on('down', onDown);
    });
  }

  /**
   * "Test the connection": lifts a stop; starts a session only when none is
   * open (stopped, or waiting for its next try), else waits for the one in
   * progress; tells what the panel holds.
   */
  async testConnection() {
    const problem = this.configProblem();
    if (problem) throw this.error(problem);
    if (!this.client.connected && !this.client.busy) {
      await this.liftStop();
      await this.setStatus(false, T.connecting);
      this.client.configure({
        host: this.config.host,
        port: this.config.port,
        code: this.config.code,
      });
      this.client.start();
      if (!this.sweeper) this.startSweeper();
    }
    const result = await this.waitForLink();
    await this.chain;
    if (result === 'timeout') {
      const progress = this.client.progress;
      throw this.error(
        progress ? fill(T.discovering, progress.zone, progress.of) : T.stillConnecting,
      );
    }
    if (result !== 'up') {
      const [, message] = this.lastStatus ? JSON.parse(this.lastStatus) : [];
      throw this.error(message ?? T.offline);
    }
    return this.connectedMessage();
  }
}

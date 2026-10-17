// -----------------------------------------------------------------------------
// One local TCP session with a Risco panel (LightSYS, Agility, WiComm…),
// ported from pyrisco (pyrisco/local/risco_socket.py and risco_local.py, MIT,
// see THIRD_PARTY_NOTICES.md): login (`RID`, `LCL`, `RMT=<code>`), discovery
// of the zones, partitions and system, keep-alive, the panel's own messages
// (acknowledged), requests and commands.
//
// Changed from pyrisco:
// - ONE request on the wire at a time (pyrisco allows 4): the commands are
//   serialized, an answer always belongs to the request just sent;
// - a refused access code stops the logins (no retry loop) until the
//   configuration changes or "Test the connection" is clicked; any answer
//   but ACK to `RMT` is a refusal (pyrisco retries on an error answer);
// - reconnection with growing waits, never under 10 s; a watchdog; a
//   timeout during the discovery fails the session (never a partial list);
// - an error answer is told apart from no answer: a request that may have
//   reached the panel is reported `sent: true`, never "not sent".
//
// Events: 'up' { snapshot }, 'down' { reason, retryIn, refused, unsupported,
// stopped, contended }, 'partition' { id, status }, 'zone' { id, status },
// 'system' { status }.
//
// The access code is never logged: frames are logged by a label only.
// -----------------------------------------------------------------------------

import { EventEmitter } from 'node:events';
import { createConnection } from 'node:net';
import { LIMITS, TIMINGS } from '../constants.js';
import { FrameReader, RiscoCodec } from './frame.js';
import { capabilities, isLegacy, zonePartitions, zoneStatus } from './panel.js';

const silent = { debug() {}, info() {}, warn() {}, error() {} };

const MIN_ID = 1;
const MAX_ID = 49;

/**
 * kind: `offline` (nothing sent), `late` (withdrawn or too late, nothing
 * sent), `timeout` (sent, no answer), `lost` (the session ended while it
 * waited), `panel` (the panel answered an error),
 * `crc` (an answer came back damaged). `sent` tells whether the request may
 * have reached the panel.
 */
export class RiscoError extends Error {
  constructor(message, kind, { sent = false, code } = {}) {
    super(message);
    this.kind = kind;
    this.sent = sent;
    this.code = code;
  }
}

/** `PSTT1=--E-R` -> `--E-R`. */
export function valueOf(reply) {
  const text = String(reply ?? '');
  const at = text.indexOf('=');
  if (at < 0) throw new RiscoError('Unexpected answer from the panel', 'panel', { sent: true });
  return text.slice(at + 1);
}

/** Errors that only mean "this object does not exist" during the discovery. */
const skippable = (err) =>
  err instanceof RiscoError && (err.kind === 'panel' || err.kind === 'crc');

export class RiscoClient extends EventEmitter {
  constructor({
    connect = (options) => createConnection(options),
    timers = globalThis,
    now = Date.now,
    logger = silent,
  } = {}) {
    super();
    this.connectFn = connect;
    this.timers = timers;
    this.now = now;
    this.logger = logger;
    this.options = { host: '', port: 1000, code: '' };
    this.socket = undefined;
    this.generation = 0;
    this.running = false;
    this.ready = false;
    this.stopped = false;
    this.failures = 0;
    this.shortSessions = 0;
    this.loginDrops = 0;
    this.inLogin = false;
    this.queue = [];
    this.inflight = undefined;
    this.snapshot = undefined;
    this.reconnectTimer = undefined;
    this.connectTimer = undefined;
    this.ticker = undefined;
  }

  configure({ host, port, code }) {
    this.options = { host, port, code };
  }

  get connected() {
    return this.ready;
  }

  start() {
    this.stop();
    this.running = true;
    this.stopped = false;
    this.failures = 0;
    this.shortSessions = 0;
    this.loginDrops = 0;
    this.inLogin = false;
    this.open();
  }

  stop() {
    this.running = false;
    this.generation += 1;
    if (this.reconnectTimer) {
      this.timers.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.close({ goodbye: true });
  }

  clearTimers() {
    if (this.connectTimer) {
      this.timers.clearTimeout(this.connectTimer);
      this.connectTimer = undefined;
    }
    if (this.ticker) {
      this.timers.clearInterval(this.ticker);
      this.ticker = undefined;
    }
  }

  /** Ends the socket; every waiting request fails (sent or not, as it was). */
  close({ goodbye = false } = {}) {
    this.clearTimers();
    const socket = this.socket;
    const wasReady = this.ready;
    this.socket = undefined;
    this.ready = false;
    this.snapshot = undefined;
    const inflight = this.inflight;
    this.inflight = undefined;
    if (inflight) {
      this.timers.clearTimeout(inflight.timer);
      inflight.reject(
        new RiscoError('The connection to the panel ended', 'lost', { sent: inflight.written }),
      );
    }
    for (const entry of this.queue.splice(0)) {
      entry.reject(new RiscoError('Not connected to the panel', 'offline'));
    }
    if (!socket) return;
    socket.removeAllListeners();
    socket.on('error', () => undefined);
    if (goodbye && wasReady && this.codec) {
      // Frees the panel for the next client at once (pyrisco sends DCN too).
      try {
        socket.write(this.codec.encode(this.nextId(), 'DCN'));
        this.logger.debug('Risco <- DCN');
        socket.end?.();
      } catch {
        // The socket is going anyway.
      }
      const timer = this.timers.setTimeout(() => socket.destroy(), TIMINGS.closeGrace);
      timer?.unref?.();
      return;
    }
    socket.destroy();
  }

  // --- Connection -------------------------------------------------------------

  open() {
    const generation = this.generation;
    const { host, port } = this.options;
    this.codec = new RiscoCodec();
    this.reader = new FrameReader({
      onFrame: (frame) => {
        if (generation === this.generation) this.frame(generation, frame);
      },
      onDrop: (why) => this.logger.warn(`Risco: ${why}, dropped`),
    });
    this.lastId = MIN_ID - 1;
    this.timeouts = 0;
    this.logger.debug(`Connecting to the Risco panel at ${host}:${port}`);
    let socket;
    try {
      socket = this.connectFn({ host, port });
    } catch (err) {
      this.lost(generation, `connection failed: ${err.message}`);
      return;
    }
    this.socket = socket;
    socket.setNoDelay?.(true);
    this.connectTimer = this.timers.setTimeout(
      () => this.lost(generation, 'connection timed out'),
      TIMINGS.connectTimeout,
    );
    socket.on('connect', () => {
      if (generation !== this.generation) return;
      this.timers.clearTimeout(this.connectTimer);
      this.connectTimer = undefined;
      this.startedAt = this.now();
      this.lastReceived = this.now();
      this.session(generation);
    });
    socket.on('data', (chunk) => {
      if (generation !== this.generation) return;
      this.lastReceived = this.now();
      this.reader.push(chunk);
    });
    socket.on('error', (err) => this.lost(generation, err.code ?? err.message));
    socket.on('close', () => this.lost(generation, 'connection closed by the panel'));
  }

  /** The session ended: reconnect later, unless stopped or refused. */
  lost(generation, reason, { refused = false, unsupported = false } = {}) {
    if (generation !== this.generation) return;
    this.generation += 1;
    const wasUp = this.ready;
    const duringLogin = this.inLogin;
    this.inLogin = false;
    this.close();
    if (!this.running) return;
    if (wasUp) {
      this.shortSessions =
        this.now() - this.startedAt < TIMINGS.shortSession ? this.shortSessions + 1 : 0;
    }
    // A panel may close the socket on a wrong code instead of answering it:
    // twice in a row is a refusal, never a loop.
    if (duringLogin && !refused) {
      this.loginDrops += 1;
      if (this.loginDrops >= LIMITS.loginDrops) {
        refused = true;
        reason = 'connection closed at each access code';
      }
    }
    const contended = this.shortSessions >= LIMITS.shortSessions;
    let retryIn;
    if (refused || unsupported) {
      // Never again by itself: a refused code tried in a loop could lock the panel.
      this.stopped = true;
      this.running = false;
    } else if (contended) {
      retryIn = TIMINGS.contendedRetry;
    } else {
      this.failures = wasUp ? 1 : this.failures + 1;
      retryIn = TIMINGS.backoff[Math.min(this.failures - 1, TIMINGS.backoff.length - 1)];
    }
    if (retryIn !== undefined) {
      this.reconnectTimer = this.timers.setTimeout(() => {
        this.reconnectTimer = undefined;
        if (this.running) this.open();
      }, retryIn);
    }
    this.emit('down', {
      reason,
      retryIn,
      refused,
      unsupported,
      stopped: this.stopped,
      contended,
      wasUp,
    });
  }

  /** Login, then discovery; 'up' once everything was read. */
  async session(generation) {
    try {
      const panelId = Number.parseInt(valueOf(await this.request('RID', { internal: true })), 16);
      if (!Number.isFinite(panelId)) throw new Error('the panel id is not a number');
      this.codec.setPanelId(panelId);
      const local = await this.request('LCL', { internal: true });
      if (local !== 'ACK') throw new Error('the panel refused the local session');
      let login;
      this.inLogin = true;
      try {
        login = await this.request(`RMT=${this.options.code}`, {
          internal: true,
          label: 'RMT=<access code>',
        });
      } catch (err) {
        if (!(err instanceof RiscoError) || err.kind !== 'panel') throw err;
        login = err.code ?? 'error';
      }
      if (generation !== this.generation) return;
      this.inLogin = false;
      if (login !== 'ACK') {
        this.logger.error('Risco: the panel refused the access code');
        this.lost(generation, 'access code refused', { refused: true });
        return;
      }
      this.loginDrops = 0;
      this.logger.info('Risco: logged in');
      this.ticker = this.timers.setInterval(() => this.tick(generation), TIMINGS.keepAlive);
      const snapshot = await this.discover(generation);
      if (!snapshot || generation !== this.generation) return;
      this.snapshot = undefined;
      this.ready = true;
      this.failures = 0;
      this.emit('up', { snapshot });
    } catch (err) {
      if (generation !== this.generation) return;
      this.lost(generation, err.message);
    }
  }

  async discover(generation) {
    const internal = { internal: true };
    const type = valueOf(await this.request('PNLCNF', internal)).trim();
    const legacy = isLegacy(type);
    const firmware = legacy ? '' : valueOf(await this.request('FSVER?', internal)).trim();
    const caps = capabilities(type, firmware);
    if (!caps) {
      this.logger.error(`Risco: panel type ${type.slice(0, 20)} is not supported`);
      this.lost(generation, `panel type ${type.slice(0, 20)} not supported`, { unsupported: true });
      return undefined;
    }
    this.logger.info(`Risco: ${caps.model} panel (${caps.type}), firmware ${firmware || '?'}`);
    let serial = '';
    try {
      serial = valueOf(await this.request('PNLSERD', internal)).trim();
    } catch (err) {
      if (!skippable(err)) throw err;
    }
    // Messages of the panel that come during the discovery update what was read.
    this.snapshot = { panel: { ...caps, serial }, zones: {}, partitions: {}, system: undefined };
    for (let id = 1; id <= Math.min(caps.zones, LIMITS.maxZones); id += 1) {
      const zone = await this.discoverZone(id, legacy);
      if (zone && this.snapshot) this.snapshot.zones[id] = zone;
    }
    for (let id = 1; id <= Math.min(caps.partitions, LIMITS.maxPartitions); id += 1) {
      const partition = await this.discoverPartition(id);
      if (partition && this.snapshot) this.snapshot.partitions[id] = partition;
    }
    try {
      const label = valueOf(await this.request('SYSLBL?', internal)).trim();
      const status = valueOf(await this.request('SSTT?', internal));
      if (this.snapshot) this.snapshot.system = { label, status };
    } catch (err) {
      if (!skippable(err)) throw err;
    }
    return this.snapshot;
  }

  async discoverZone(id, legacy) {
    const internal = { internal: true };
    try {
      const type = Number.parseInt(valueOf(await this.request(`ZTYPE*${id}?`, internal)), 10);
      if (!type) return undefined;
      let tech = '';
      if (!legacy) {
        tech = valueOf(await this.request(`ZLNKTYP${id}?`, internal)).trim();
        if (tech === 'N') return undefined;
      }
      const status = valueOf(await this.request(`ZSTT*${id}?`, internal));
      if (!zoneStatus(status).used) return undefined;
      const label = valueOf(await this.request(`ZLBL*${id}?`, internal)).trim();
      const partitions = zonePartitions(valueOf(await this.request(`ZPART&*${id}?`, internal)));
      return { id, type, tech, status, label, partitions };
    } catch (err) {
      if (skippable(err)) return undefined;
      throw err;
    }
  }

  async discoverPartition(id) {
    const internal = { internal: true };
    try {
      const status = valueOf(await this.request(`PSTT${id}?`, internal));
      if (!status.includes('E')) return undefined;
      const label = valueOf(await this.request(`PLBL${id}?`, internal)).trim();
      return { id, status, label };
    } catch (err) {
      if (skippable(err)) return undefined;
      throw err;
    }
  }

  tick(generation) {
    if (generation !== this.generation || !this.socket) return;
    if (this.now() - this.lastReceived > TIMINGS.watchdog) {
      this.logger.warn('Risco: nothing received for too long, reconnecting');
      this.lost(generation, 'no answer from the panel');
      return;
    }
    // Only when the line is idle: a busy line is alive.
    if (!this.inflight && this.queue.length === 0) {
      this.request('CLOCK', { internal: true }).catch(() => undefined);
    }
  }

  // --- Frames -----------------------------------------------------------------

  nextId() {
    this.lastId = this.lastId >= MAX_ID ? MIN_ID : this.lastId + 1;
    return this.lastId;
  }

  frame(generation, frame) {
    let decoded;
    try {
      decoded = this.codec.decode(frame);
    } catch (err) {
      this.logger.warn(`Risco: ${err.message}`);
      this.lost(generation, 'protocol error');
      return;
    }
    const { id, text, crcOk } = decoded;
    if (id === null) {
      // An error answer without id: the panel did not take the id, the next
      // request uses it again (as pyrisco does).
      this.lastId = this.lastId <= MIN_ID ? MAX_ID : this.lastId - 1;
      this.answer(undefined, text, crcOk);
      return;
    }
    if (id <= MAX_ID) {
      this.answer(id, text, crcOk);
      return;
    }
    // The panel's own message: acknowledged with its id, whatever it says.
    try {
      this.socket?.write(this.codec.encode(id, 'ACK'));
    } catch (err) {
      this.logger.warn(`Risco: acknowledging a message failed: ${err.message}`);
    }
    if (!crcOk) {
      this.logger.warn('Risco: a message of the panel had a wrong CRC, ignored');
      return;
    }
    this.incoming(text);
  }

  answer(id, text, crcOk) {
    const entry = this.inflight;
    if (!entry || (id !== undefined && id !== entry.id)) {
      this.logger.debug(`Risco: late or unexpected answer ${id ?? '-'} ignored`);
      return;
    }
    this.timers.clearTimeout(entry.timer);
    this.inflight = undefined;
    this.timeouts = 0;
    if (!crcOk) {
      entry.reject(new RiscoError('The answer of the panel was damaged', 'crc', { sent: true }));
    } else if (text[0] === 'N' || text[0] === 'B') {
      entry.reject(
        new RiscoError(`The panel answered ${text.slice(0, 8)}`, 'panel', {
          sent: true,
          code: text.slice(0, 8),
        }),
      );
    } else {
      entry.resolve(text);
    }
    this.pump();
  }

  incoming(text) {
    if (text.startsWith('CLOCK') || text.startsWith('EVENT=')) return;
    const at = text.indexOf('=');
    if (at < 0) return;
    const command = text.slice(0, at);
    const status = text.slice(at + 1);
    const number = (prefix) => Number.parseInt(command.slice(prefix.length).replace('*', ''), 10);
    if (command.startsWith('ZSTT')) {
      const id = number('ZSTT');
      if (!Number.isInteger(id)) return;
      if (this.snapshot?.zones[id]) this.snapshot.zones[id].status = status;
      else if (this.ready) this.emit('zone', { id, status });
    } else if (command.startsWith('PSTT')) {
      const id = number('PSTT');
      if (!Number.isInteger(id)) return;
      if (this.snapshot?.partitions[id]) this.snapshot.partitions[id].status = status;
      else if (this.ready) this.emit('partition', { id, status });
    } else if (command.startsWith('SSTT')) {
      if (this.snapshot?.system) this.snapshot.system.status = status;
      else if (this.ready) this.emit('system', { status });
    } else {
      this.logger.debug(`Risco: message ${command.slice(0, 12)} ignored`);
    }
  }

  // --- Requests ---------------------------------------------------------------

  /**
   * Queues a request; resolves with the answer text. `label` replaces the
   * command in the logs (a frame may hold the access code). `sendBy` (a
   * time): never written after it, rejected as not sent instead. `ticket`
   * (an object) gets `written` and `cancel()`, which withdraws the request
   * while it is not written yet.
   */
  request(
    command,
    {
      timeout = TIMINGS.requestTimeout,
      label = command,
      internal = false,
      sendBy,
      ticket = {},
    } = {},
  ) {
    return new Promise((resolve, reject) => {
      ticket.written = false;
      ticket.cancel = () => false;
      if (!this.socket || (!internal && !this.ready)) {
        reject(new RiscoError('Not connected to the panel', 'offline'));
        return;
      }
      const entry = { command, label, timeout, sendBy, ticket, resolve, reject, written: false };
      ticket.cancel = () => {
        const at = this.queue.indexOf(entry);
        if (at < 0) return false;
        this.queue.splice(at, 1);
        reject(new RiscoError(`${label} withdrawn before it was sent`, 'late'));
        return true;
      };
      this.queue.push(entry);
      this.pump();
    });
  }

  pump() {
    while (
      this.queue.length > 0 &&
      this.queue[0].sendBy !== undefined &&
      this.now() > this.queue[0].sendBy
    ) {
      const late = this.queue.shift();
      late.reject(new RiscoError(`${late.label} not sent in time`, 'late'));
    }
    if (this.inflight || this.queue.length === 0 || !this.socket) return;
    const entry = this.queue.shift();
    const generation = this.generation;
    let bytes;
    try {
      entry.id = this.nextId();
      bytes = this.codec.encode(entry.id, entry.command);
    } catch (err) {
      entry.reject(new RiscoError(err.message, 'offline'));
      this.lost(generation, 'protocol error');
      return;
    }
    this.inflight = entry;
    this.logger.debug(`Risco <- ${entry.label}`);
    entry.written = true;
    entry.ticket.written = true;
    try {
      this.socket.write(bytes);
    } catch (err) {
      this.lost(generation, err.message);
      return;
    }
    entry.timer = this.timers.setTimeout(() => {
      if (this.inflight !== entry) return;
      this.inflight = undefined;
      this.timeouts += 1;
      entry.reject(new RiscoError(`No answer to ${entry.label}`, 'timeout', { sent: true }));
      if (this.timeouts >= LIMITS.maxTimeouts) {
        this.lost(generation, 'no answer from the panel');
        return;
      }
      this.pump();
    }, entry.timeout);
  }

  // --- Reads and commands (after the discovery only) --------------------------

  async readPartition(id, options) {
    return valueOf(await this.request(`PSTT${id}?`, options));
  }

  async readZone(id, options) {
    return valueOf(await this.request(`ZSTT*${id}?`, options));
  }

  /** A command the panel answers ACK; any other answer is an error, sent. */
  async command(text, options) {
    const answer = await this.request(text, options);
    if (answer !== 'ACK') {
      throw new RiscoError(`The panel answered ${answer.slice(0, 8)}`, 'panel', {
        sent: true,
        code: answer.slice(0, 8),
      });
    }
  }

  arm(id, options) {
    return this.command(`ARM=${id}`, options);
  }

  armStay(id, options) {
    return this.command(`STAY=${id}`, options);
  }

  disarm(id, options) {
    return this.command(`DISARM=${id}`, options);
  }

  /** `ZBYPAS` toggles the bypass of a zone: the caller decides on a fresh status. */
  toggleBypass(id, options) {
    return this.command(`ZBYPAS=${id}`, options);
  }
}

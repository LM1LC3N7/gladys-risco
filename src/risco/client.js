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
 * waited), `withdrawn` (its option was switched off before the write,
 * nothing sent), `panel` (the panel answered an error, N.. or B..), `unexpected`
 * (an answer that is neither ACK nor an error), `ambiguous` (an error answer
 * without id while an earlier request timed out: it may belong to either),
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
  if (at < 0) {
    throw new RiscoError('Unexpected answer from the panel', 'unexpected', { sent: true });
  }
  return text.slice(at + 1);
}

/**
 * The only error that means "this object does not exist" during the
 * discovery: an error answer of the panel (N.., B..). A damaged or
 * unexpected answer is asked once more, then fails the session.
 */
const skippable = (err) => err instanceof RiscoError && err.kind === 'panel';

const retryable = (err) =>
  err instanceof RiscoError && (err.kind === 'crc' || err.kind === 'unexpected');

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
    this.loggedIn = false;
    this.uncertain = false;
    this.closedAt = undefined;
    this.progress = undefined;
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

  /** A socket is open (connecting, logging in, discovering or up). */
  get busy() {
    return Boolean(this.socket);
  }

  start() {
    this.stop();
    this.running = true;
    this.stopped = false;
    this.failures = 0;
    this.shortSessions = 0;
    this.loginDrops = 0;
    this.inLogin = false;
    this.openSoon(0);
  }

  /**
   * Opens a session after `wait`, and never sooner than sessionGap after the
   * last one closed: the panel needs a few seconds to reset its scrambling
   * between two sessions (pyrisco's note), whatever the path (new address,
   * new code, "Test the connection", a reconnection).
   */
  openSoon(wait) {
    const gap = this.closedAt === undefined ? 0 : this.closedAt + TIMINGS.sessionGap - this.now();
    const delay = Math.max(wait, gap, 0);
    if (delay === 0) {
      this.open();
      return;
    }
    this.reconnectTimer = this.timers.setTimeout(() => {
      this.reconnectTimer = undefined;
      if (this.running) this.open();
    }, delay);
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
    const loggedIn = this.loggedIn;
    this.socket = undefined;
    this.ready = false;
    this.loggedIn = false;
    this.snapshot = undefined;
    this.progress = undefined;
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
    this.closedAt = this.now();
    socket.removeAllListeners();
    socket.on('error', () => undefined);
    // Once logged in (discovery included), DCN frees the panel at once.
    if (goodbye && loggedIn && this.codec) {
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
    this.uncertain = false;
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
    if (retryIn !== undefined) this.openSoon(retryIn);
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
      this.loggedIn = true;
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
    const type = (await this.ask('PNLCNF')).trim();
    const legacy = isLegacy(type);
    const firmware = legacy ? '' : (await this.ask('FSVER?')).trim();
    const caps = capabilities(type, firmware);
    if (!caps) {
      this.logger.error(`Risco: panel type ${type.slice(0, 20)} is not supported`);
      this.lost(generation, `panel type ${type.slice(0, 20)} not supported`, { unsupported: true });
      return undefined;
    }
    this.logger.info(`Risco: ${caps.model} panel (${caps.type}), firmware ${firmware || '?'}`);
    let serial = '';
    try {
      serial = (await this.ask('PNLSERD')).trim();
    } catch (err) {
      if (!skippable(err)) throw err;
    }
    // Messages of the panel that come during the discovery update what was read.
    this.snapshot = { panel: { ...caps, serial }, zones: {}, partitions: {}, system: undefined };
    const zones = Math.min(caps.zones, LIMITS.maxZones);
    for (let id = 1; id <= zones; id += 1) {
      this.progress = { zone: id, of: zones };
      const zone = await this.discoverZone(id, legacy);
      if (zone && this.snapshot) this.snapshot.zones[id] = zone;
    }
    for (let id = 1; id <= Math.min(caps.partitions, LIMITS.maxPartitions); id += 1) {
      const partition = await this.discoverPartition(id);
      if (partition && this.snapshot) this.snapshot.partitions[id] = partition;
    }
    try {
      const label = (await this.ask('SYSLBL?')).trim();
      const status = await this.ask('SSTT?');
      if (this.snapshot) this.snapshot.system = { label, status };
    } catch (err) {
      if (!skippable(err)) throw err;
    }
    return this.snapshot;
  }

  /** A discovery request: its value; a damaged or unexpected answer is asked once more. */
  async ask(command) {
    try {
      return valueOf(await this.request(command, { internal: true }));
    } catch (err) {
      if (!retryable(err)) throw err;
      this.logger.debug(`Risco: ${command} answered badly, asked again`);
      try {
        return valueOf(await this.request(command, { internal: true }));
      } catch (again) {
        // Never read as "no such object": the session fails, as on a timeout.
        if (retryable(again)) {
          throw new Error(`Risco: no clear answer to ${command} during the discovery`, {
            cause: again,
          });
        }
        throw again;
      }
    }
  }

  async discoverZone(id, legacy) {
    try {
      const type = Number.parseInt(await this.ask(`ZTYPE*${id}?`), 10);
      if (!type) return undefined;
      let tech = '';
      if (!legacy) {
        tech = (await this.ask(`ZLNKTYP${id}?`)).trim();
        if (tech === 'N') return undefined;
      }
      const status = await this.ask(`ZSTT*${id}?`);
      if (!zoneStatus(status).used) return undefined;
      const label = (await this.ask(`ZLBL*${id}?`)).trim();
      const partitions = zonePartitions(await this.ask(`ZPART&*${id}?`));
      return { id, type, tech, status, label, partitions };
    } catch (err) {
      if (skippable(err)) return undefined;
      throw err;
    }
  }

  async discoverPartition(id) {
    try {
      const status = await this.ask(`PSTT${id}?`);
      if (!status.includes('E')) return undefined;
      const label = (await this.ask(`PLBL${id}?`)).trim();
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
      if (this.uncertain) {
        // A request timed out earlier: this error may answer it, or the one
        // in flight. Nothing is known: the id is kept, the request in flight
        // fails as "may have been sent".
        this.ambiguous(text);
        return;
      }
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
    if (this.overflowing(generation)) return;
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
    // An answer with the id of the request: the line is in step again.
    if (id !== undefined) this.uncertain = false;
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
      this.reportRead(entry.command, text);
      entry.resolve(text);
    }
    this.pump();
  }

  /**
   * A status read once up is reported like the panel's own messages, right
   * at its answer: the model sees reads and messages in the order they came.
   */
  reportRead(command, text) {
    if (!this.ready) return;
    const match = /^(PSTT|ZSTT\*)(\d+)\?$/.exec(command);
    const at = text.indexOf('=');
    if (!match || at < 0) return;
    const id = Number(match[2]);
    const status = text.slice(at + 1);
    this.emit(match[1] === 'PSTT' ? 'partition' : 'zone', { id, status });
  }

  ambiguous(text) {
    const entry = this.inflight;
    this.logger.warn(`Risco: error ${text.slice(0, 8)} without id after a timeout: ambiguous`);
    if (!entry) return;
    this.timers.clearTimeout(entry.timer);
    this.inflight = undefined;
    entry.reject(
      new RiscoError(`Ambiguous answer ${text.slice(0, 8)} to ${entry.label}`, 'ambiguous', {
        sent: true,
        code: text.slice(0, 8),
      }),
    );
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
      check,
    } = {},
  ) {
    return new Promise((resolve, reject) => {
      ticket.written = false;
      ticket.cancel = () => false;
      if (!this.socket || (!internal && !this.ready)) {
        reject(new RiscoError('Not connected to the panel', 'offline'));
        return;
      }
      const entry = {
        command,
        label,
        timeout,
        sendBy,
        ticket,
        check,
        resolve,
        reject,
        written: false,
      };
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
    // Last look before the socket: a command whose option was switched off
    // while it waited is withdrawn, never written.
    if (entry.check && !entry.check()) {
      entry.reject(new RiscoError(`${entry.label} withdrawn: not allowed any more`, 'withdrawn'));
      this.pump();
      return;
    }
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
    if (this.overflowing(generation)) return;
    entry.timer = this.timers.setTimeout(() => {
      if (this.inflight !== entry) return;
      this.inflight = undefined;
      this.timeouts += 1;
      // A late answer may still come: until an answer with a known id, an
      // error without id cannot be told apart.
      this.uncertain = true;
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

  /**
   * A command the panel answers ACK. An error answer (N.., B..) rejects as
   * `panel` (refused); any other answer as `unexpected`: it was sent, its
   * effect is unknown.
   */
  async command(text, options) {
    const answer = await this.request(text, options);
    if (answer !== 'ACK') {
      throw new RiscoError(`Unexpected answer ${answer.slice(0, 8)}`, 'unexpected', {
        sent: true,
        code: answer.slice(0, 8),
      });
    }
  }

  /** A panel (or a peer) flooding us faster than the socket drains: cut. */
  overflowing(generation) {
    if ((this.socket?.writableLength ?? 0) <= LIMITS.maxPendingWrite) return false;
    this.logger.warn('Risco: too much data waiting to be written, session cut');
    this.lost(generation, 'write buffer full');
    return true;
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

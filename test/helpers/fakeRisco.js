// -----------------------------------------------------------------------------
// An in-memory Risco panel: no socket, no network. `connect` is given to the
// client in place of net.createConnection; each call opens a session that
// behaves like the panel as pyrisco describes it (RID, LCL, RMT, discovery
// requests, commands answered ACK, its own messages to acknowledge), records
// what the client asked, and scrambles its frames once the client knows the
// panel id (option `scramble`).
// -----------------------------------------------------------------------------

import { EventEmitter } from 'node:events';
import { FrameReader, RiscoCodec } from '../../src/risco/frame.js';

/** Lets every queued delivery and the promise chains behind it run. */
export async function settle(rounds = 20) {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** Settles until `check()` is true (at most `rounds` x 20 turns). */
export async function until(check, rounds = 200) {
  for (let i = 0; i < rounds; i += 1) {
    if (check()) return;
    await settle(5);
  }
  throw new Error('condition never met');
}

class FakeSocket extends EventEmitter {
  constructor(server) {
    super();
    this.server = server;
    this.destroyed = false;
    this.codec = new RiscoCodec();
    this.codec.setPanelId(server.panelId);
    this.reader = new FrameReader({ onFrame: (frame) => server.receive(this, frame) });
    this.pushId = 49;
    this.knowsId = false;
  }

  setNoDelay() {}

  write(bytes) {
    if (this.destroyed) throw new Error('write after destroy');
    const copy = Buffer.from(bytes);
    queueMicrotask(() => {
      if (!this.destroyed) this.reader.push(copy);
    });
    return true;
  }

  end() {
    this.ended = true;
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    queueMicrotask(() => this.emit('close'));
  }

  /** Server side: a frame to the client. */
  send(id, text) {
    if (this.destroyed) return;
    this.codec.scrambled = this.server.scramble && this.knowsId;
    const frame = this.codec.encode(id, text);
    queueMicrotask(() => {
      if (!this.destroyed) this.emit('data', frame);
    });
  }

  /** Raw bytes to the client. */
  raw(bytes) {
    queueMicrotask(() => {
      if (!this.destroyed) this.emit('data', Buffer.from(bytes));
    });
  }
}

const defaultZones = () => ({
  1: { type: 1, tech: 'W', status: '--------', label: 'Porte entree', parts: '1' },
  2: { type: 3, tech: 'W', status: '--------', label: 'Couloir', parts: '1' },
  5: { type: 2, tech: 'E', status: '--------', label: 'Garage', parts: '3' },
});

const defaultPartitions = () => ({
  1: { status: '--E-R---', label: 'Maison' },
  2: { status: '--E-R---', label: 'Garage' },
});

export class FakeRisco {
  constructor({
    code = '5678',
    panelId = 0x1234,
    type = 'RP432:01.00',
    firmware = '3.0.0 (build)',
    scramble = true,
    zones = defaultZones(),
    partitions = defaultPartitions(),
    refuse = 'answer',
    refuseConnections = 0,
  } = {}) {
    this.code = code;
    this.panelId = panelId;
    this.type = type;
    this.firmware = firmware;
    this.scramble = scramble;
    this.zones = zones;
    this.partitions = partitions;
    this.system = { label: 'Ma maison', status: '--------' };
    /** How a wrong code is refused: 'answer' (N05), 'nack', 'close'. */
    this.refuse = refuse;
    this.refuseConnections = refuseConnections;
    this.pushChanges = true;
    this.sockets = [];
    /** Every request the client sent: [{ session, text }]. */
    this.log = [];
    /** (text) -> true: that request gets no answer. */
    this.hold = () => false;
    /** (text) -> a promise: that request is answered once it resolves. */
    this.gate = () => undefined;
    /** (text) -> a reply, or undefined for the normal one. */
    this.reply = () => undefined;
    this.connect = this.connect.bind(this);
  }

  connect(options) {
    this.options = options;
    const socket = new FakeSocket(this);
    socket.session = this.sockets.length + 1;
    this.sockets.push(socket);
    if (this.refuseConnections > 0) {
      this.refuseConnections -= 1;
      queueMicrotask(() => {
        const err = new Error('connect ECONNREFUSED');
        err.code = 'ECONNREFUSED';
        socket.emit('error', err);
      });
      return socket;
    }
    queueMicrotask(() => socket.emit('connect'));
    return socket;
  }

  get current() {
    return this.sockets.at(-1);
  }

  /** The requests of the current session, keep-alives left out. */
  get requests() {
    const session = this.current?.session;
    return this.log.filter((e) => e.session === session && e.text !== 'CLOCK').map((e) => e.text);
  }

  /** The commands (no question mark, no login), every session. */
  get commands() {
    return this.log.map((e) => e.text).filter((t) => /^(ARM|STAY|DISARM|ZBYPAS)=/.test(t));
  }

  receive(socket, frame) {
    const { id, text } = socket.codec.decode(frame);
    if (id > 49) return; // the client's ACK of a message of ours
    this.log.push({ session: socket.session, text });
    if (this.hold(text)) return;
    const gate = this.gate(text);
    if (gate) {
      gate.then(() => this.respond(socket, id, text));
      return;
    }
    this.respond(socket, id, text);
  }

  respond(socket, id, text) {
    const custom = this.reply(text);
    if (custom !== undefined) {
      if (custom === null) return;
      socket.send(id, custom);
      return;
    }
    if (text === 'RID') {
      socket.send(id, `RID=${this.panelId.toString(16).toUpperCase()}`);
      socket.knowsId = true;
      return;
    }
    if (text.startsWith('RMT=')) {
      if (text.slice(4) === this.code) {
        socket.send(id, 'ACK');
      } else if (this.refuse === 'close') {
        socket.destroy();
      } else {
        socket.send(id, this.refuse === 'nack' ? 'NACK' : 'N05');
      }
      return;
    }
    socket.send(id, this.answer(text) ?? 'N19');
    // A change made by a command is announced, as the panel does for any change.
    const m = /^(ARM|STAY|DISARM|ZBYPAS)=(\d+)$/.exec(text);
    if (m && this.pushChanges) {
      const zone = m[1] === 'ZBYPAS';
      const status = zone ? this.zones[m[2]]?.status : this.partitions[m[2]]?.status;
      if (status) this.push(`${zone ? 'ZSTT' : 'PSTT'}${m[2]}=${status}`);
    }
  }

  answer(text) {
    let m;
    if (text === 'LCL' || text === 'DCN') return 'ACK';
    if (text === 'CLOCK') return 'CLOCK=18/10/2026 12:00';
    if (text === 'PNLCNF') return `PNLCNF=${this.type}`;
    if (text === 'FSVER?') return `FSVER=${this.firmware}`;
    if (text === 'PNLSERD') return 'PNLSERD=123456789';
    if (text === 'SYSLBL?') return `SYSLBL=${this.system.label}`;
    if (text === 'SSTT?') return `SSTT=${this.system.status}`;
    if ((m = /^ZTYPE\*(\d+)\?$/.exec(text))) return `ZTYPE=${this.zones[m[1]]?.type ?? 0}`;
    if ((m = /^ZLNKTYP(\d+)\?$/.exec(text))) return `ZLNKTYP=${this.zones[m[1]]?.tech ?? 'N'}`;
    if ((m = /^ZSTT\*(\d+)\?$/.exec(text))) return `ZSTT=${this.zones[m[1]]?.status ?? '-------N'}`;
    if ((m = /^ZLBL\*(\d+)\?$/.exec(text))) return `ZLBL=${this.zones[m[1]]?.label ?? ''}   `;
    if ((m = /^ZPART&\*(\d+)\?$/.exec(text))) return `ZPART=${this.zones[m[1]]?.parts ?? '0'}`;
    if ((m = /^PSTT(\d+)\?$/.exec(text)))
      return `PSTT=${this.partitions[m[1]]?.status ?? '--------'}`;
    if ((m = /^PLBL(\d+)\?$/.exec(text))) return `PLBL=${this.partitions[m[1]]?.label ?? ''}`;
    if ((m = /^(ARM|STAY|DISARM)=(\d+)$/.exec(text))) {
      const partition = this.partitions[m[2]];
      if (!partition) return 'N19';
      const base = partition.status.replace(/[AHa1-4]/g, '-');
      partition.status =
        m[1] === 'DISARM'
          ? base
          : `${m[1] === 'ARM' ? 'A' : 'H'}${base.slice(1)}`.replace('R', '-');
      return 'ACK';
    }
    if ((m = /^ZBYPAS=(\d+)$/.exec(text))) {
      const zone = this.zones[m[1]];
      if (!zone) return 'N19';
      zone.status = zone.status.includes('Y')
        ? zone.status.replace('Y', '-')
        : `${zone.status.slice(0, 3)}Y${zone.status.slice(4)}`;
      return 'ACK';
    }
    return undefined;
  }

  /** A message of the panel (it expects an ACK with the same id). */
  push(text) {
    const socket = this.current;
    socket.pushId = socket.pushId >= 99 ? 50 : socket.pushId + 1;
    socket.send(socket.pushId, text);
  }

  /** The panel closes the session. */
  drop() {
    this.current.destroy();
  }
}

export const quietLogger = () => {
  const lines = [];
  const log = (level) => (message) => lines.push(`${level} ${message}`);
  return {
    lines,
    debug: log('debug'),
    info: log('info'),
    warn: log('warn'),
    error: log('error'),
  };
};

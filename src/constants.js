// -----------------------------------------------------------------------------
// Fixed values: manifest keys, Gladys value enums, protocol limits and timings.
// The SDK exports the Gladys categories and types, not the state values: the
// ones used here mirror server/utils/constants.js of the core.
// -----------------------------------------------------------------------------

/** Manifest keys: frozen, users store them in scenes and dashboards. */
export const ACTIONS = {
  TEST_CONNECTION: 'test_connection',
};

export const SCENE_ACTIONS = {
  ARM: 'arm',
  DISARM: 'disarm',
};

export const SCENE_TRIGGERS = {
  ALARM_TRIGGERED: 'alarm_triggered',
  ARMED: 'armed',
  DISARMED: 'disarmed',
};

/** Arming modes of a scene action or of an `armed` event (frozen: scenes compare them). */
export const ARM_MODES = ['armed_away', 'armed_stay'];

/**
 * Every mode a partition can show. `armed_group`: armed by group (A to D)
 * only, from a keypad or a key fob; Gladys never arms by group.
 */
export const MODES = ['disarmed', 'armed_away', 'armed_stay', 'armed_group'];

/** How a zone shows in Gladys (frozen: stored in the configuration). */
export const ZONE_KINDS = ['opening', 'motion', 'smoke', 'leak'];

/** Gladys core values (server/utils/constants.js). */
export const OPENING_SENSOR_STATE = { OPEN: 0, CLOSE: 1 };
export const BUTTON_PUSH = { PRESSED: 1 };

export const DEFAULT_PORT = 1000;

export const LIMITS = {
  /** Highest partition number of the supported panels (LightSYS+, ProSYS Plus). */
  maxPartitions: 32,
  /** Highest zone number of the supported panels (LightSYS+). */
  maxZones: 512,
  /** A frame longer than this is not a Risco frame: dropped, the reader waits for the next start. */
  maxFrame: 1024,
  /** Requests in a row without an answer before the link counts as dead. */
  maxTimeouts: 3,
  /** States per minute sent to Gladys (the core admits 300). */
  statesPerMinute: 240,
  /** Part of it only the panel and partition states may use. */
  priorityStates: 60,
  /** Scene events per minute (the core admits 300); alarm_triggered is never dropped. */
  eventsPerMinute: 120,
  /** Tries of an alarm_triggered event refused by Gladys or the network. */
  alarmEventTries: 3,
  /** Sessions shorter than shortSession in a row: another local client is likely. */
  shortSessions: 3,
  /** Sessions closed by the panel while it checked the access code, in a row: a refusal. */
  loginDrops: 2,
};

export const TIMINGS = {
  /** TCP connection to the panel. */
  connectTimeout: 10_000,
  /** One request to the panel (pyrisco waits 10 s; 5 s keeps the commands within Gladys' ack). */
  requestTimeout: 5_000,
  /** A keep-alive (`CLOCK`) this often, as pyrisco does. */
  keepAlive: 5_000,
  /** Nothing received for this long while connected: the link is dead. */
  watchdog: 30_000,
  /**
   * Waits before reconnecting, in a row (the last one repeats). Never under
   * 6 s: the panel needs a few seconds to reset its encryption state after a
   * session (pyrisco's note), else the next session starts encrypted.
   */
  backoff: [10_000, 30_000, 60_000, 120_000, 300_000],
  /** The wait after several short sessions in a row (another client kicks us out). */
  contendedRetry: 5 * 60_000,
  /** A session that ends this soon after its start counts as short. */
  shortSession: 30_000,
  /** The disconnect request (`DCN`) gets this long before the socket is destroyed. */
  closeGrace: 1_000,
  /**
   * Gladys waits 5 s for a set_value ack. A command must be sent by
   * sendBy after it was asked (else it is refused, nothing sent), and the
   * answer is awaited until answerBy (then "sent, not confirmed").
   */
  sendBy: 3_500,
  answerBy: 4_500,
  /** The fresh read of a partition or a zone before a command, at most. */
  readBefore: 1_500,
  /** The partition or zone is read again this long after a command. */
  readBack: 2_000,
  /** A bypass (a toggle on the panel) is not sent again for this zone until seen or expired. */
  bypassGuard: 30_000,
  /** A transition seen this long after a Gladys command is credited to it. */
  commandMemory: 2 * 60_000,
  /** How often the unchanged states get their heartbeat checked. */
  sweep: 60_000,
  /** An unchanged state is sent again this often… */
  stateHeartbeat: 30 * 60_000,
  /** …plus a per-feature offset within this spread. */
  heartbeatSpread: 5 * 60_000,
  /** Waits between two tries of an alarm_triggered event. */
  alarmEventRetry: [5_000, 20_000],
  /** "Test the connection" waits this long for the session (the manifest allows 30 s). */
  testWait: 25_000,
};

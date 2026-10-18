# TODO - Risco (LightSYS, Agility, WiComm) v1

Handoff document: what is done, what was decided, what comes next. Keep it
up to date at the end of every milestone.

## Working method

- One milestone at a time, one commit per milestone, tests green before moving on.
- After each milestone: `npm run format:check`, `npm run lint`, `npm test`
  (Node 22 and 24), `npm run audit`, `npx github:GladysAssistant/integration-store .`,
  then update README, `docs/fr.md`, `docs/en.md`, `CHANGELOG.md` and this file.
- No forum topic of its own, no forum post from a module session: lot 7 was
  claimed in /t/10385 (post #262); the main session posts one recap per wave.
- The `gladys-assistant-integration` topic is added at the first real release only.

## Status

- [x] **Milestone 1 - core** (2026-10-18): own TCP client on `node:net`
      ported from pyrisco 0.8.1 (frames, CRC, scrambling, login, discovery,
      keep-alive, panel messages acknowledged, one request at a time);
      panel / partition / zone devices; read-only states and push buttons;
      arming allowed, disarming and bypassing opt-in; fresh read before every
      command, serialized, deadlines inside Gladys' 5 s; refused code stop
      persisted in `/data`; scene triggers `alarm_triggered`, `armed`,
      `disarmed`; scene actions `arm`, `disarm`; "Test the connection";
      fr/en. Tested against an in-memory panel only (frames checked byte for
      byte against pyrisco's own encoder).
- [x] **Review fixes** (2026-10-18, extra review of fef05c2: 1 blocking, 5
      important, 12 minor): see "Decisions after the review" below.
- [ ] **Milestone 2 - real panel**: run against a real LightSYS and an
      Agility / WiComm; capture real frames (anonymised) as fixtures; fix
      what differs (see below).
- [ ] **Milestone 3 - more**: Risco cloud as an option (pyrisco
      `cloud/`: login, site, PIN session, SSE or polling, token renewal);
      group arming (`GARM*<g>=<p>`) behind the arming option; outputs
      (`MAX_OUTPUTS`); the panel event log (`EVENT=`) as a text feature;
      panel clock (`CLOCK=`); a label encoding option (pyrisco's
      `encoding`).
- [ ] **Milestone 4 - first release**: Docker image check, Release workflow,
      topic, GHCR package public.

## To check on a real panel

- The answer to a wrong `RMT` code: `N..`, `NACK`, or a closed socket?
  (all three stop the logins here; a silent panel twice too).
- Does the panel push `PSTT` / `ZSTT` after a command from Gladys, or only
  after a keypad change? (a read back 2 s after each command covers both).
- The status letters beyond pyrisco's (tamper, trouble, exit delay): are
  there more worth showing?
- Time to read 50 / 512 zones one request at a time (pyrisco runs 4 at once).
- `ZBYPAS` on an armed partition: refused (`N..`) or applied?
- Whether a panel connected to the Risco cloud still accepts a local client,
  and how a second local client is treated (refused or kicks the first).
- The keep-alive every 5 s (pyrisco's) on Agility panels.

## Decisions

- **Local only in v1.** pyrisco's cloud part is a second client of its own
  (user login, site list, PIN session, SSE with reconnects, token renewal,
  "assumed" states): not "simple" enough for this milestone; noted for
  milestone 3.
- **Own client, no dependency**: no maintained Risco client on npm under a
  usable licence; pyrisco (MIT) is ported and credited in
  `THIRD_PARTY_NOTICES.md` (copied into the image with `LICENSE`).
  Runtime dependency: the SDK only.
- **Version 0.1.0, set by hand once**: the template ships 1.0.0; the
  sibling modules start at 0.1.x, so `package.json`, `package-lock.json`, the
  manifest `version` and the `docker_image` tag were set together to 0.1.0 in
  milestone 1, before any release. Every later version comes from
  Actions -> Release (the first patch release gives 0.1.1).
- **Frames**: one linear reader that follows the DLE escapes (pyrisco re-reads
  while the frame ends with DLE ETX, which a real escaped DLE before ETX
  defeats), frames bounded to 1024 bytes, the CRC over the bytes received.
  The vectors in `test/frame.test.js` were produced by pyrisco's own
  `risco_crypt.py` (run once with the portable Python of this PC).
- **One request on the wire at a time** (pyrisco: 4): an answer always
  belongs to the request just sent; the commands are serialized above it.
- **Refused access code**: any answer but ACK to `RMT`, or two sessions in a
  row closed by the panel during `RMT`, stop the logins at once (no retry,
  no timer). The stop is saved in `/data/risco-state.json` with the address
  only (never the code nor a hash of it: a 4-digit code is brute-forced from
  any hash); it is lifted by saving a new address, port or code, or by "Test
  the connection".
- **Unsupported panel type**: stop (in memory only), "Test the connection"
  tries again.
- **Reconnection**: 10 s, 30 s, 1 min, 2 min, then 5 min (never under the
  ~5 s the panel needs to reset its scrambling between sessions); three
  sessions in a row dropped within 30 s: another client, 5 min between tries.
  A timeout during the discovery fails the session (never a partial device
  list); an error answer for one zone only skips that zone.
- **Commands**: buttons (`button`/`push`, value 1 only, strictly), never a
  switch or a binary, so no "turn everything off" can disarm. Each command
  reads the partition or zone from the panel first and decides on that read
  only (already in the mode: nothing sent; armed in another mode: refused,
  disarm first). Sent within 3.5 s of the request or withdrawn ("nothing
  was sent"); answer awaited until 4.5 s; no answer, a lost session or a
  damaged answer after the write: "sent, without confirmation" + read back
  in 2 s. An `N..` answer: "refused by the panel" with its code.
- **Bypass**: `ZBYPAS` toggles. Decided on a fresh `ZSTT`; after the request
  left (ACK or unconfirmed), a guard refuses another bypass of the zone until
  the panel shows the bypass asked or 30 s pass; a panel refusal sets no
  guard.
- **Disarm** needs no user code on a Risco panel (the access code is the
  key): off by default, the docs say it plainly.
- **Ids**: `panel:risco`, `partition:<n>`, `zone:<n>`: one panel per
  integration, numbered by the panel; a new IP keeps them. The zone state
  feature is keyed by its kind (`zone:<n>:opening` …); a device published
  again keeps the features of the created device it no longer has (no
  `structure_changed`, no lost history).
- **Partition state**: a read-only `text` feature in the configured language
  (`Disarmed`, `Armed (away)`, `Armed (stay)`, `Armed (group)`), no history;
  the scene triggers carry the frozen codes (`armed_away`, `armed_stay`,
  `armed_group`).
- **Scene events**: one per transition; none for the first status seen after
  a start (an alarm already in progress fires nothing, documented);
  transitions seen after a reconnection fire. `alarm_triggered` carries the
  first zone in alarm of the partition when the panel says it.
- **Rate limits**: the publisher of gladys-envisalink (same author): only
  changed values, a heartbeat every 30 min plus a per-feature offset, 240
  states/min of which 60 kept for the panel and partitions, 120 events/min,
  `alarm_triggered` never dropped and tried 3 times.
- **Units and categories**: only core ones (`input`, `battery-low`,
  `tamper`, `text`, `siren`, `button`, `opening-sensor`, `motion-sensor`,
  `smoke-sensor`, `leak-sensor`), no unit at all.
- **Not checked**: Docker is not installed on this PC, so no image build and
  no end-to-end test in a container; never run against a real panel.

## Decisions after the review (2026-10-18)

- **B1 - options read again before every send**: `allow_arm`,
  `allow_disarm`, `allow_bypass` are checked when the command is asked, again
  inside the queue after the fresh read, and once more in `send()` right
  before the request is queued. Switched off meanwhile: refused, "nothing was
  sent".
- **I1 - only N.. / B.. is a refusal**: any other answer to `ARM`, `STAY`,
  `DISARM`, `ZBYPAS` (an echo, garbage) is `unexpected`: "sent, without
  confirmation", `onSent()` (bypass guard, Gladys credit) and a read back.
- **I2 - uncertain line**: every request timeout sets a flag, lowered by the
  first answer whose id matches the request in flight. While it is up, an
  error answer without id is `ambiguous` (`sent: true`): a command is "sent,
  without confirmation" with its guard, a read is "state unreadable"; the id
  is never taken back then (pyrisco's decrement only when in step).
- **I3 - "Test the connection"** starts a session only when no socket is open
  (stopped, or waiting for the next try); otherwise it waits for the session
  in progress and, on its 25 s limit, answers "discovery in progress (zone
  x/n)".
- **I4 - docs and manifest**: the access code alone disarms; it travels only
  scrambled (not protected) on the local network, readable by any device of
  it; with 5678 any device of the network can drive the panel (have the
  installer change it); once disarming is allowed, every Gladys user, scene
  and the mobile app can disarm without any code.
- **M1 - session gap**: the client keeps `closedAt`; no session opens before
  `closedAt + 6 s`, on every path (`start()` for a new address/port/code or
  the button, and the reconnections).
- **M2 - fresh read deadline**: the read before a command carries a ticket;
  a timer withdraws it at `sendBy` (3.5 s) if it is still waiting for the
  line, so the refusal comes within Gladys' 5 s.
- **M3 - scene actions**: a missing partition or mode is refused, never
  replaced by a default (Gladys sends the manifest defaults itself).
- **M4 - flood**: messages for zones or partitions not found at the discovery
  are dropped before anything else; the model changes at once but the
  publication, scene events and status come once per event loop turn; the
  session is cut when more than 64 KB wait in the socket write buffer.
- **M5 - DCN** is sent as soon as `RMT` got ACK (discovery included), not only
  once the session is up.
- **M6 - wording**: "refused the access code, or closed the connection while
  checking it".
- **M7 - docs**: each reconnection reads all the zones again; commands are
  refused meanwhile.
- **M8 - publisher**: a feature forgotten while its value is on its way is
  not remembered when the value lands (as the SDK's publishChangedStates).
- **M9 - starts never overlap**: `start()` runs one at a time; the sweeper
  interval is cleared before it is set again.
- **M10 - by_gladys**: a Gladys command credits only the first matching
  transition; its entry is deleted then.
- **M11 - CRC**: the whole table is compared with pyrisco's base64 one; the
  notice describes the 6 s gap and the other changes.
- **M12 - docs**: changing the kind of a created zone adds a feature and keeps
  the old one (and its history).

## Decisions after the approval round 1 (2026-10-18)

- **Model changes in emission order (regression of M4)**: the client's
  events change the model when they are emitted, in their order: the
  session up (model replaced, `applyUp`), the panel messages, the session
  down (offline), and the status reads, which the client now emits itself as
  `partition` / `zone` events at their answer (reads after the discovery
  only). `guard()` only queues what talks to Gladys: publication, scene
  events, status, transports. A message right after a new session can no
  longer be overwritten by the older discovery snapshot (test R13).
- **N1**: a command request carries a `check` of its option, called by
  `pump()` right before the socket write; false: rejected `withdrawn`, never
  written, refused with the option's message.
- **N2**: during the discovery, only an error answer (N.., B..) means "no such
  object". A damaged (`crc`) or unexpected answer is asked once more; a
  second one fails the session like a timeout.
- **N3**: a state forgotten while on its way is queued again when its request
  lands (not only left out of `last`).

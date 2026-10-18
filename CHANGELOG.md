# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- Local connection to Risco LightSYS, LightSYS+, Agility, WiComm and ProSYS
  Plus panels over TCP (port 1000), with the protocol of pyrisco 0.8.1:
  frames, CRC, scrambling, login with the access code, discovery of the
  zones, partitions and system, keep-alive, the panel's own messages.
- One device per partition: read-only state (disarmed, armed away, armed
  stay, armed by group), alarm in progress, ready to arm, and arm away / arm
  stay / disarm push buttons (never a switch).
- One device per zone: open or closed, or motion / smoke / leak by
  configuration; alarm, bypassed, battery low; bypass / unbypass buttons.
- The panel: link, mains power, battery low, tamper.
- Scene triggers `alarm_triggered`, `armed`, `disarmed`; scene actions
  `arm` and `disarm`; a "Test the connection" button.
- Safety: arming allowed, disarming and bypassing off by default; every
  command decided on the state read from the panel just before it, one at a
  time, sent within 3.5 s or not at all; a command that may have left is
  reported "sent, without confirmation" and read again; a bypass guarded
  until the panel shows it.
- A refused access code stops the logins, kept across restarts in `/data`
  (the address only, never the code); spaced reconnections; detection of
  another local client.
- State and scene event budgets under the Gladys limits.
- French and English names, messages and guides.

### Security

- The arming, disarming and bypass options are read again right before each
  send: one switched off while a command waits stops it, nothing sent.
- Only an error answer (N.., B..) of the panel counts as a refusal; any other
  answer after a command is "sent, without confirmation" with its bypass
  guard and a read back. An error answer without id after a timeout is
  treated as ambiguous (sent), and the command id is then kept.
- No new session sooner than 6 s after the last one closed; DCN sent as soon
  as the access code is accepted; the session is cut on a write buffer over
  64 KB; messages for unknown zones or partitions are ignored and bursts are
  published once.
- Docs and configuration: the access code alone disarms and travels only
  scrambled on the local network; change the default 5678; once disarming is
  allowed, any Gladys user, scene or the mobile app can disarm without a
  code.

### Fixed

- "Test the connection" no longer opens a second session during the
  discovery: it waits for it and tells its progress.
- The status read before a command is withdrawn in time when the line is
  busy, so the refusal arrives within Gladys' 5 s.
- Scene actions without partition or mode are refused instead of guessed.
- A Gladys command credits a single transition (`by_gladys`); two starts no
  longer overlap; a state forgotten while being sent is sent again.
- A panel message received right after a reconnection could be overwritten
  by the older state read during the discovery (Gladys showed "Disarmed" on
  an armed panel): every model change now applies in the order the panel
  sent it, status reads included.
- A command's option is checked one last time right before the socket write.
- During the discovery, a damaged or unexpected answer is asked again, then
  fails the session; it never hides a zone.
- A state forgotten while being sent is queued again at once.
  [Unreleased]: https://github.com/LM1LC3N7/gladys-risco/commits/main

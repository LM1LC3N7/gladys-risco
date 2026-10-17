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

[Unreleased]: https://github.com/LM1LC3N7/gladys-risco/commits/main

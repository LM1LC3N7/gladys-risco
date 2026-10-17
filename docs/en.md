# Risco (LightSYS, Agility, WiComm) for Gladys

This integration connects a **Risco** alarm panel to Gladys Assistant,
**locally** on your network (TCP), without the Risco cloud.

> **Never tested on a real panel.** The protocol comes from the
> [pyrisco](https://github.com/OnFreund/pyrisco) library (the one of the Home
> Assistant Risco integration), ported to JavaScript and checked against a
> simulated panel only. Try it first while at home, with the panel disarmed,
> and report what goes wrong.
>
> Unofficial integration, not affiliated with Risco Group.

## Supported panels

The types pyrisco knows: Agility 4 (RW032), Agility (RW132), WiComm (RW232),
WiCommPro (RW332), LightSYS (RP432), LightSYS+ (RP432MP), LightSYS Air
(RW432MPV), ProSYS Plus / GT Plus (RP512). The panel needs a network (IP)
module that Gladys can reach.

## What you get

- **Risco panel**: connected or not, mains power, battery low, box tamper.
- **One device per partition** (named after the panel):
  - a read-only **State**: disarmed, armed (away), armed (stay), armed
    (group);
  - **Alarm in progress** and **Ready to arm**;
  - three **buttons**: arm away, arm stay, disarm.
- **One device per zone** (named after the panel): open or closed (or motion,
  smoke, leak, depending on the kind you choose), alarm, bypassed, battery
  low, and two **buttons**: bypass, unbypass.
- **Scene triggers**: alarm triggered (with the zone when the panel tells
  it), partition armed (mode, asked by Gladys or not), partition disarmed.
- **Scene actions**: arm (away or stay), disarm.

No command is a switch: a "turn everything off" from a voice assistant,
HomeKit or a scene cannot disarm the alarm. The states are read-only, the
commands are buttons.

## Configuration

1. **Address of the panel**: the IP address of its network module. Give it a
   fixed address in your router.
2. **Port**: 1000 unless your installer changed it.
3. **Access code of the panel**: the remote access code (5678 by default),
   not a keypad user code. It is a secret field: kept by Gladys in its
   database, never shown again in the interface, sent only to the panel. It
   never appears in the logs.
4. **Kind of the zones** (optional): for example `2:motion, 5:smoke,
7-9:motion`. Kinds: `opening` (the default), `motion`, `smoke`, `leak`.
5. **Safety**: see below.
6. **Language of the names**: French or English.

The **Test the connection** button connects at once and tells the model, the
state of the partitions and the number of zones.

The first connection reads every possible zone of the panel (50 for a
LightSYS, 512 for a LightSYS+): it can take from a few seconds to a minute.
The devices then show in the Discovery tab.

## Safety

- **Arming** is allowed by default ("Allow arming from Gladys").
- **Disarming is off by default.** The panel asks for no user code to
  disarm: the access code is enough. Allow it only if your Gladys is well
  protected (accounts, remote access). Disarming also silences an alarm in
  progress.
- **Bypassing a zone is off by default**: a bypassed zone no longer triggers
  the alarm.
- Before every command, the integration **reads the state from the panel**
  and decides on it, never on what it holds in memory. Commands go one at a
  time.
- A command that cannot leave in time (slow panel, state unreadable) is
  refused with "nothing was sent". A command that left without an answer
  from the panel is reported "sent, without confirmation" and the state is
  read again two seconds later: it is never reported "not sent".
- A bypass is a toggle on the panel: once one is sent, the zone takes no
  other bypass until the panel shows the result (30 s at most).
- Every command, sent or refused, is written in the integration logs.

## Connection and refused code

- The panel accepts **one local connection at a time**: stop any other
  software connected to it (Home Assistant, a Risco bridge). If the panel
  closes the connection right after each opening, the integration says so
  and spaces its tries (5 minutes).
- After a cut, the new tries are spaced: 10 s, 30 s, 1 min, 2 min, then every
  5 minutes.
- **If the panel refuses the access code, the integration stops** and does
  not try again by itself, even after a restart (a wrong code tried in a loop
  could lock the panel). Fix the code then save, or click "Test the
  connection". The file `/data/risco-state.json` keeps only the address
  concerned, never the code.

## Known limits

- Never tested on a real panel (see above); the status letters read are the
  ones pyrisco documents.
- Local only: the Risco cloud is not supported in this version. Depending on
  your panel's setup, the Risco cloud connection and the local one may get in
  each other's way (not checked).
- Arming by group (A to D) is shown, not commanded.
- An alarm already in progress when the integration starts fires no scene
  (only the changes seen do).
- Zone names are read as UTF-8; other encodings of the panel may give
  replaced characters.

## Privacy

Everything stays on your network: the integration only talks to the panel.

## Licence

Apache-2.0. Protocol logic ported from pyrisco (MIT, On Freund): see
`THIRD_PARTY_NOTICES.md`.

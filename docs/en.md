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
   never appears in the logs. See also "The access code" below.
4. **Kind of the zones** (optional), for example:
   `2:motion, 5:smoke, 7-9:motion`. Kinds: `opening` (the default),
   `motion`, `smoke`, `leak`. Changing the kind of a zone already created in
   Gladys adds a new feature and keeps the old one (and its history): delete
   the old one by hand if you no longer want it.
5. **Safety**: see below.
6. **Language of the names**: French or English.

The **Test the connection** button connects at once when no connection is in
progress, else waits for the one in progress (with "discovery in progress
(zone x/n)" if it takes long), and tells the model, the state of the
partitions and the number of zones.

The first connection reads every possible zone of the panel (50 for a
LightSYS, 512 for a LightSYS+): it can take from a few seconds to a minute.
The devices then show in the Discovery tab. **Every reconnection reads all
the zones again the same way, and the commands are refused meanwhile**
("nothing was sent").

## The access code

- **The access code alone is enough to disarm**: the panel asks for no user
  code for the commands it receives over the network.
- It travels on your local network only **scrambled, not protected**: the
  scrambling is undone with the id the panel gives to whoever asks. Any
  device of your network listening to the traffic can read it.
- **With the default code 5678, any device of your network can control the
  panel**, disarming included, without Gladys. Have your installer change
  it.
- Protect your network (a separate guest Wi-Fi for the devices you are not
  sure of).

## Safety

- **Arming** is allowed by default ("Allow arming from Gladys").
- **Disarming is off by default.** Once checked, **every Gladys user, every
  scene and the Gladys mobile app can disarm, without any code**. Allow it
  only if your Gladys is well protected (accounts, remote access). Disarming
  also silences an alarm in progress.
- **Bypassing a zone is off by default**: a bypassed zone no longer triggers
  the alarm.
- The options are read again right before every send: an option unchecked
  while a command waits its turn stops that command.
- Before every command, the integration **reads the state from the panel**
  and decides on it, never on what it holds in memory. Commands go one at a
  time.
- A command that cannot leave in time (slow panel, state unreadable) is
  refused with "nothing was sent". A command that left without a clear
  answer from the panel (no answer, an unexpected or ambiguous one) is
  reported "sent, without confirmation" and the state is read again two
  seconds later: it is never reported "not sent". Only an error answer of
  the panel (N.., B..) is reported "refused".
- A bypass is a toggle on the panel: once one is sent (accepted or not
  confirmed), the zone takes no other bypass until the panel shows the
  result (30 s at most).
- Every command, sent or refused, is written in the integration logs.

## Connection and refused code

- The panel accepts **one local connection at a time**: stop any other
  software connected to it (Home Assistant, a Risco bridge). If the panel
  closes the connection right after each opening, the integration says so
  and spaces its tries (5 minutes).
- After a cut, the new tries are spaced: 10 s, 30 s, 1 min, 2 min, then every
  5 minutes. Two connections are always at least 6 seconds apart (the time
  the panel needs to reset).
- **If the panel refuses the access code, or closes the connection while
  checking it (twice in a row), the integration stops** and does not try
  again by itself, even after a restart (a wrong code tried in a loop could
  lock the panel). Fix the code then save, or click "Test the connection".
  The file `/data/risco-state.json` keeps only the address concerned, never
  the code.

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

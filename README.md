# Risco (LightSYS, Agility, WiComm) for Gladys Assistant

External integration for [Gladys Assistant](https://gladysassistant.com):
**Risco** alarm panels (LightSYS, LightSYS+, Agility, WiComm, ProSYS Plus),
**locally** over TCP, without the Risco cloud.

> **Never tested on a real panel.** Unofficial, not affiliated with Risco
> Group.

- Partitions: state (disarmed, armed away, armed stay, armed by group), alarm
  in progress, ready to arm; arm away, arm stay and disarm **buttons**.
- Zones: open or closed (or motion, smoke, leak), alarm, bypassed, battery
  low; bypass and unbypass **buttons**.
- Panel: link, mains power, battery, tamper.
- Scene triggers: alarm triggered, partition armed, partition disarmed. Scene
  actions: arm, disarm.
- Safety: arming allowed; **disarming and bypassing off by default**; every
  command decided on the state read from the panel right before it, one at a
  time; the access code is a secret field, never logged; a refused code stops
  the logins (no loop), even across restarts.

User guides: [français](docs/fr.md), [English](docs/en.md).

## Development

```bash
npm install
npm test               # node --test (Node 22 and 24), against an in-memory panel
npm run lint
npm run format:check
npm run audit          # npm audit --omit=dev
npx github:GladysAssistant/integration-store .
```

Layout: `src/risco/` (frames, panel model, TCP client), `src/app.js`
(devices, states, scene events, commands), `src/devices.js`,
`src/publisher.js` (rate limits), `test/helpers/fakeRisco.js` (the simulated
panel). See `CLAUDE.md` and `TODO.md`.

## Credits and licence

Apache-2.0 (`LICENSE`). The local protocol is ported from
[pyrisco](https://github.com/OnFreund/pyrisco) 0.8.1 by On Freund (MIT): see
`THIRD_PARTY_NOTICES.md`.

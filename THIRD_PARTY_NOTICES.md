# Third-party notices

This integration is licensed under the Apache License 2.0 (see `LICENSE`). It
contains logic ported to JavaScript from the project below. The ported parts
were rewritten, not copied; the changes are described below.

## pyrisco

<https://github.com/OnFreund/pyrisco> (package `pyrisco`, version 0.8.1), by
On Freund, the library of the Home Assistant Risco integration. MIT License
(`LICENSE` of the repository). Its notice:

```
MIT License

Copyright (c) 2020 On Freund

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

Ported from its local part (`pyrisco/local/`):

- `risco_crypt.py`, in `src/risco/frame.js`: the frame layout (STX, the
  scrambling flag, the command id, the `0x17` separator, the CRC, ETX), the
  DLE escapes, the CRC table (computed here, checked against pyrisco's in
  `test/frame.test.js`), the scrambling buffer derived from the panel id.
- `risco_socket.py`, in `src/risco/client.js`: the login (`RID`, `LCL`,
  `RMT=<code>`), the command ids 1 to 49, the error answers without id (and
  the id taken again after one), the acknowledgement of the panel's own
  messages, the `CLOCK` keep-alive every 5 seconds, `DCN` at the end, the
  pause the panel needs between two sessions (pyrisco sleeps 5 s after a
  close; here no session opens sooner than 6 s after the last one closed,
  on every path).
- `risco_local.py`, `panels.py`, `partition.py`, `zone.py`, `system.py`, in
  `src/risco/client.js` and `src/risco/panel.js`: the discovery requests
  (`PNLCNF`, `FSVER?`, `PNLSERD`, `ZTYPE*`, `ZLNKTYP`, `ZSTT*`, `ZLBL*`,
  `ZPART&*`, `PSTT`, `PLBL`, `SYSLBL?`, `SSTT?`), the capabilities of each
  panel type, the meaning of the status letters, the commands `ARM`, `STAY`,
  `DISARM` and `ZBYPAS`, and the bypass decided on the zone status.

Changed: one request on the wire at a time (pyrisco allows four); the frames
cut in one linear pass that follows the escapes, with a bounded length; the
CRC over the bytes received; any answer but ACK to the access code is a
refusal that stops the logins (pyrisco reconnects after an error answer); a
timeout during the discovery fails the session instead of dropping the
object; reconnection with growing waits; a command never written after its
deadline; `DCN` sent as soon as the access code was accepted (discovery
included); an error answer without id after a timeout is ambiguous and the
id is not taken back then; a command answered neither ACK nor an error is
"sent, not confirmed" (pyrisco reads it as a failure). The cloud part of
pyrisco (`pyrisco/cloud/`) is not ported.

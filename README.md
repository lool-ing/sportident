# @lool-ing/sportident

Read SPORTident orienteering cards from Node.js. The library talks to a
BSM7-USB or BSM8-USB station over serial and decodes SI5, SI6, SI8,
SI9, SI10, SI11 and SIAC cards, including the SIAC reserve records
(the first start and finish punch after a clear). It can also read a
station's backup memory and listen for autosend punches from online
controls and radio gateways.

Used by [⅃ooL](https://github.com/lool-ing/lool), an orienteering
competition system.

## Install

```sh
npm install @lool-ing/sportident
```

Needs Node.js 26 or newer. Tested on Linux; the serial port comes from
[`serialport`](https://serialport.io). On Linux, add yourself to the
`dialout` group, and remove `brltty` if it grabs `/dev/ttyUSB0`.

## Use

```ts
import { SerialTransport, SiMainStation } from '@lool-ing/sportident';
import type { BaseSiCard } from '@lool-ing/sportident';

const transport = new SerialTransport({ path: '/dev/ttyUSB0', baudRate: 38400 });
const station = new SiMainStation(transport);

station.on('cardRead', (card: BaseSiCard) => {
  const { punches = [], startTime, finishTime } = card.raceResult;
  console.log(card.cardNumber, startTime, finishTime, punches);
});
station.on('error', (err: Error) => console.error(err));
transport.on('error', (err: Error) => console.error(err));

await transport.open();
await station.readCards();
// later: await station.close();
```

`cardRead` fires once per insertion: one successful read per insertion
within the same connected session. The station may report the same card
again without a removal; that only gets an ACK until the card is taken
away. After a process restart or reconnect (`readCards()`) the card may be
read again. A failed read is retried on the next insertion report.

Other entry points, all exported from the package root:

- `AutosendListener` emits a `punch` for each autosend record on a
  transport (online controls, radio gateways).
- `readBackupMemory(station)` and `readCoupledBackupMemory(station)`
  read a station's backup memory, directly or through a coupled
  check unit.
- `NdjsonEmitter` writes card events as one JSON object per line.
- `parse`, `render`, `CRC16` and `proto` for the wire protocol.

## Command line

- `lool-readout` prints every card read as NDJSON on stdout.
  `--device <path>` (or `LOOL_DEVICE`, default `/dev/ttyUSB0`),
  `--pretty`, `--once`. `--record <name>` saves a wire transcript and
  `--replay <name>` checks the decoder against one.
- `lool-trainer --course 31,32,33` checks each card against a course,
  for training without a competition system.

Both print `--help`.

## Develop

```sh
pnpm install
pnpm lint && pnpm typecheck && pnpm build && pnpm test
```

Tests run without hardware: they replay recorded transcripts from
`tests/fixtures/`. `scripts/hardware-smoke.sh` records new ones from a
real station. Read [AGENTS.md](AGENTS.md) before you send a pull
request.

## Licence

MIT, see [LICENSE](LICENSE). Much of the code is ported from
[sportident.js](https://github.com/allestuetsmerweh/sportident.js)
(MIT); [NOTICE.md](NOTICE.md) lists what came from where.
SPORTident's own documentation, which SPORTident gives out on request,
was used for facts and is not redistributed here.

SPORTident is a trademark of SPORTident GmbH. This is an independent
project, not affiliated with or endorsed by SPORTident.

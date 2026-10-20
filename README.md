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

## Raw pages

After a successful read, `card.rawPages()` returns a copy of the blocks the
reader fetched, exactly as the station returned them:

```ts
const { cardType, layout, blocks } = card.rawPages();
// blocks: { block: number; bytes: Uint8Array /* 128 bytes */ }[]
```

`cardType` is the type the detection command chose, not a guess from the card
number. A block that is not listed was never read; a listed block is complete.
`lool-readout --include-raw-pages` adds the same data to each `card_read` line
as `raw_pages: { layout, blocks: [{ block, b64 }] }`.

`decodeRawPages(raw)` runs the same decoder on a `RawPages` (for example a
sanitised copy) and returns the card, with the card number taken from the
bytes and unlisted blocks left unread. To build a `RawPages` from a
`raw_pages` NDJSON line, take `card_type` as `cardType` and turn each
`b64` into `bytes` with `Buffer.from(b64, 'base64')`. `VERSION` is the
library version.

It throws "malformed RawPages" when the `cardType` is unknown, the `layout`
does not match it, a `block` is not a whole number within the card or is
repeated, block 0 is missing, or `bytes` is not a 128-byte `Uint8Array`. It
also throws when a block that holds one of the punch slots `punchCount` says
exist (SI6, SI8, SI9, SI10, SI11, SIAC keep punches in blocks of their own)
is not listed. If all those blocks are present it does not throw, even when
the decoder stops early at an invalid slot and returns fewer punches.

```ts
import { decodeRawPages, VERSION } from '@lool-ing/sportident';

const card = decodeRawPages(sanitised); // card.raceResult.punches, card.punchCount, ...
```

The library does not sanitise. `RAW_LAYOUTS[cardType].personal` lists the
card addresses (`block * 128 + offset`, both ends inclusive) that hold
personal data, so a consumer can blank them before storing:

| Card             | Holder               | UID       |
| ---------------- | -------------------- | --------- |
| SI5              | 0x01-0x03            |           |
| SI6, SI6*        | 0x28-0x7F, 0x80-0xFB |           |
| SI8              | 0x20-0x87            | 0x00-0x03 |
| SI9              | 0x20-0x37            | 0x00-0x03 |
| SI10, SI11, SIAC | 0x20-0x9F            | 0x00-0x03 |

SI6 keeps the owner's programmed start number, name, country and club in
block 0 and the rest (phone, e-mail, address, birth date) in block 1, which
the reader never fetches; both ranges are listed. SI6 has no chip serial. A
personal range can cover a block the reader did not fetch (SI8 0x80-0x87 is
in block 1, which a card without punches never reads), so consumers blank
only the bytes of blocks they have. The ranges are tested not to overlap any decoded race field (times, codes, punches,
subseconds, SIAC reserve records and block-1 codes).

## Reader BT (Bluetooth)

`@lool-ing/sportident/reader-bt` reads cards from a SPORTident Reader BT
over Bluetooth Low Energy. It has no Node APIs, so it runs in a browser.
The Reader BT reads SIAC, SI-Card 8–11, SI-pCard and ComCard; SI-Card 5 and
6 need a USB reader. Not yet tested on a real reader; see
[docs/reader-bt.md](docs/reader-bt.md) for what it relies on and the open
questions.

`ReaderBt` takes a `GattLink`: an adapter that has connected, found the
characteristics by UUID (`READER_BT_UUID`) and can write and subscribe.
On a card in it asks for the minimal readout, emits `cardRead` once per
insertion and plays the reader's OK feedback. A card out before the reply
drops the read. The readout carries decoded punches, not raw pages; store
`readout.bytes` and decode them again with `decodeReadout`. `toRaceResult`
gives the same fields as a serial card's `raceResult`. For a SIAC the client
asks for the complete readout to get its battery voltage, versions and
battery date (`readout.battery`); the owner data in it is zeroed in
`readout.bytes` and never decoded.

## Command line

- `lool-readout` prints every card read as NDJSON on stdout.
  `--device <path>` (or `LOOL_DEVICE`, default `/dev/ttyUSB0`),
  `--baud <38400|4800|auto>` (or `LOOL_BAUD`, default `38400`; some
  stations only answer at 4800, `auto` tries 38400 then 4800),
  `--pretty`, `--once`. `--record <name>` saves a wire transcript and
  `--replay <name>` checks the decoder against one. A card number outside
  the supported ranges is not read: it gives a `card_unsupported` event
  (`card_number`, `detect_command`, `card_series_byte?`) and a stderr line.
- `lool-trainer --course 31,32,33` checks each card against a course,
  for training without a competition system. Takes `--device` and
  `--baud` too.

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

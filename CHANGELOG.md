# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - unreleased

First release.

### Added

- Card readout from a BSM7-USB or BSM8-USB station over serial: SI5, SI6,
  SI8, SI9, SI10, SI11 and SIAC, including the SIAC reserve records (the
  first start and finish punch after a clear). SIAC always reads block 1.
- `SiMainStation` with events `cardInserted`, `cardRead`, `cardRemoved`,
  `cardUnsupported`, `frameError` and `connectionChanged`. One successful
  read per insertion within the same connected session: the station
  reporting the same card again before it is removed gets only an ACK; after
  a reconnect (`readCards()`) or a process restart the card may be read
  again.
- Robust readout: a card pulled or swapped mid-read sends nothing more and is
  never reported with the next card's data; NAK and no reply are retried
  (three tries, 2.5 s / 2.5 s / 2 s, 500 ms after a NAK); line noise and
  unfinished frames are dropped after 1 s and the receiver resyncs on the
  next whole, CRC-checked frame.
- Backup memory, read directly (`readBackupMemory`) or through a coupled
  check unit (`readCoupledBackupMemory`), with each record's date, half day,
  time and 1/256 s decoded.
- `AutosendListener` for autosend punches from online controls and radio
  gateways.
- The punch day of week (`weekdayRaw`, 0-7) on modern cards and SI6, and
  `dayOfWeekFromRaw`.
- Raw pages of each read (`card.rawPages()`) and the card address ranges that
  hold personal data (`RAW_LAYOUTS`), for every card type including SI6 (its
  owner's programmed start number counts as personal data).
- `decodeRawPages(raw)` decodes stored raw pages again with the same decoder,
  and rejects a malformed `RawPages`. `VERSION` is the package version, to
  store with each read.
- `NdjsonEmitter`: one JSON object per line for `connection_changed`,
  `card_inserted`, `card_read`, `card_removed`, `card_unsupported` and
  `frame_error`. A punch with a code but no valid time has
  `seconds_in_half_day` and `half_day` `null`; `weekday` is 0-6 or `null`,
  with the raw 0-7 in `weekday_raw`.
- Command line: `lool-readout` (NDJSON or `--pretty`, `--record` and
  `--replay` of wire transcripts, `--include-raw-pages`) and `lool-trainer`
  (checks each card against a course); both take `--device` and
  `--baud 38400|4800|auto`.
- Wire protocol helpers `parse`, `render`, `CRC16` and `proto` (extended
  protocol only).

[0.1.0]: https://github.com/lool-ing/sportident/releases/tag/v0.1.0

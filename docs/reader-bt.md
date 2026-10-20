# SPORTident Reader BT

The Reader BT reads cards over Bluetooth Low Energy. SPORTident publishes its
interface at <https://docs.sportident.com/developers/reader-bt>; read that page
for the full layouts. This note lists, in our words, what
`@lool-ing/sportident/reader-bt` relies on and what is still open. It was
written from the page as read on 2026-10-20, without a reader to test against.

## What the client relies on

- **Cards.** The product page
  (<https://docs.sportident.com/products/stations/reader-bt>) lists SIAC,
  SI-Card 8–11, SI-pCard and ComCard. SI-Card 5 and 6 need a USB reader.
- **Connection.** No operating-system pairing. The reader advertises the
  settings service (`bd510001-…`) for about 20 seconds after a wake-up card.
  Characteristics are found by UUID on every connection; the adapter does
  this and may need to request an MTU of 517.
- **Card readout service** `bd510011-6aec-4628-a146-f3e95bc49e62`: card
  state `bd510012-…` (notify) and card data `bd510013-…` (notify, write with
  response). Subscribe with notifications; the reader does not support
  indications.
- **Messages** start with a little-endian uint16 id and uint16 payload length.
  A message too long for one notification comes as segment messages
  (`0xA101`): a flag byte (first, continuation, last), the total length in
  the first one, and the client joins the segments.
- **Card state** (`0x1101`): card number, in or out, and the reader's control
  code.
- **Minimal readout** (`0x1102`): the client writes the bare header to card
  data and the reader replies there with the card number, a card family byte
  and the punch records. Each record has a punch type (clear, check, start,
  finish, their reserve records, control), a control code and a time in
  milliseconds since Sunday 00:00. There are no raw card pages: the message
  bytes are what a consumer stores as evidence of the read, and
  `decodeReadout` decodes them again.
- **Complete readout** (`0x1103`), asked for SIAC numbers (8 000 000 to
  8 999 999) only: after the punches a SIAC sends 13 bytes with hardware and
  software version, battery voltage in millivolts and battery date, the
  values the serial read takes from block 3. Then comes the owner's personal
  data (name, contact details), which the client never decodes and zeroes in
  the stored message bytes.
- **Feedback** (`0x1110`): in readout mode the reader neither flashes nor beeps
  by itself. The client writes OK feedback after each read, the counterpart
  of the serial ACK. With `confirmReads` it waits for the app to confirm, so
  an app can store the read first. The page sets no time limit for the
  feedback.

## Left out on purpose

- The complete readout for cards other than SIAC: it adds only owner data.
- Autosend, settings, device info, sleep mode, the sessions (backup) service
  and the battery service.

## Open questions

- The page lists card family values for SI-Card 8, SI-Card 9, SI-pCard and
  SIAC only. What does the reader send for SI-Card 10, SI-Card 11 and
  ComCard? The client keeps the byte as sent.
- How does the reader answer a readout request when the card is already out,
  or the read fails? The page describes no error reply; the client drops a
  pending read on card out.
- Are the milliseconds derived from the card's 1/256 s? `toRaceResult`
  assumes so when it rounds them back to 1/256 s.
- What time does a punch with no valid time on the card carry?
- Does the reader have the SIAC measure its battery before it sends the
  voltage, or is it the value stored at the last measurement? The serial read
  can measure first (`measureSiacBattery`); the Reader BT protocol has no such
  command.
- Does the reader do anything when no feedback comes after a readout (a
  time-out, a beep, a repeated card state)? The client assumes not.
- Personal data crosses the air: the owner data of a SIAC is in every
  complete readout over an unpaired BLE link, even though the client zeroes
  it.

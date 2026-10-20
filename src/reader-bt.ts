// Authored for lool. Not ported from upstream.
//
// Entry point `@lool-ing/sportident/reader-bt`: SPORTident Reader BT over
// Bluetooth Low Energy. Separate from the main entry so serial users do not
// load it, and free of Node APIs so it runs in a browser.

export { ReaderBt } from './readerBt/ReaderBt.ts';
export type { GattLink, ReaderBtEvents } from './readerBt/ReaderBt.ts';
export {
  decodeCardState,
  decodeReadout,
  encodeMessage,
  FEEDBACK,
  isSiacNumber,
  PUNCH_TYPE,
  READER_BT_MSG,
  READER_BT_UUID,
  Reassembler,
  ReaderBtDecodeError,
  splitMessage,
  toRaceResult,
} from './readerBt/messages.ts';
export type {
  CardStateChange,
  ReaderBtPunch,
  ReaderBtReadout,
  ReassemblyResult,
  SiacBattery,
} from './readerBt/messages.ts';

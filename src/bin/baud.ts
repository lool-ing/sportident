// Authored for lool. Not ported from upstream.
//
// Baud choice shared by lool-readout and lool-trainer. Some SPORTident
// stations only answer at 4800 baud; at the default 38400 they stay silent
// and the handshake times out. `--baud 4800` picks the rate; `--baud auto`
// tries 38400 and, when SET_MS gets no answer, 4800 once.

import type { SerialTransport } from '../transport/SerialTransport.ts';
import { SendTimeoutError } from '../transport/errors.ts';

export type Baud = 38400 | 4800 | 'auto';

export const parseBaud = (value: string): Baud => {
  if (value === 'auto') return 'auto';
  if (value === '38400') return 38400;
  if (value === '4800') return 4800;
  throw new Error(`--baud must be 38400, 4800 or auto (got: ${value})`);
};

/** The rate the port is opened at. */
export const initialBaud = (baud: Baud): 38400 | 4800 => (baud === 'auto' ? 38400 : baud);

/** Runs `readCards` (the SET_MS handshake first); resolves to the rate that worked. */
export const readCardsAtBaud = async (o: {
  transport: Pick<SerialTransport, 'setBaudRate'>;
  readCards: () => Promise<void>;
  path: string;
  baud: Baud;
}): Promise<38400 | 4800> => {
  const first = initialBaud(o.baud);
  try {
    await o.readCards();
    return first;
  } catch (err) {
    if (!(err instanceof SendTimeoutError) || err.command !== 0xf0) throw err;
    if (o.baud !== 'auto') {
      const other = first === 4800 ? 38400 : 4800;
      throw new Error(
        `No answer from the station on ${o.path} at ${first} baud (${err.message}). ` +
          `Try --baud ${other} or --baud auto.`,
        { cause: err }
      );
    }
    await o.transport.setBaudRate(4800);
    try {
      await o.readCards();
      return 4800;
    } catch (err2) {
      if (!(err2 instanceof SendTimeoutError) || err2.command !== 0xf0) throw err2;
      throw new Error(
        `No answer from the station on ${o.path} at 38400 and 4800 baud (${err2.message}). ` +
          'Check the cable, the power and the device path.',
        { cause: err2 }
      );
    }
  }
};

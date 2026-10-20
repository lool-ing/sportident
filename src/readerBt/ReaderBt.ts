// Authored for lool. Not ported from upstream.
//
// Reader BT client: card in/out and the minimal readout over a GATT link that
// an adapter provides (Web Bluetooth, a native BLE plugin, a test fake). The
// adapter connects, requests the MTU and finds the characteristics by UUID;
// this class only writes and listens. No Node APIs.

import {
  decodeCardState,
  decodeReadout,
  encodeMessage,
  FEEDBACK,
  isSiacNumber,
  READER_BT_MSG,
  READER_BT_UUID,
  Reassembler,
  splitMessage,
  type ReaderBtReadout,
} from './messages.ts';

/** What the client needs from a connected Reader BT. */
export interface GattLink {
  /** Write With Response to a characteristic. */
  write(characteristic: string, bytes: Uint8Array): Promise<void>;
  /** Subscribe to notifications (not indications) of a characteristic. */
  subscribe(characteristic: string, onValue: (bytes: Uint8Array) => void): Promise<void>;
  onDisconnect(listener: () => void): void;
}

/** Plays the feedback for a read, once; later calls do nothing. */
export type ConfirmRead = (type?: keyof typeof FEEDBACK) => Promise<void>;

export interface ReaderBtEvents {
  cardInserted: (cardNumber: number) => void;
  cardRead: (readout: ReaderBtReadout, confirm: ConfirmRead) => void;
  cardRemoved: (cardNumber: number) => void;
  error: (err: Error) => void;
}

type Listeners = { [E in keyof ReaderBtEvents]: Set<ReaderBtEvents[E]> };

/**
 * Pull model: on a card in, request the readout (complete for a SIAC, for its
 * battery data, with the owner data zeroed; minimal otherwise); on its reply, emit
 * cardRead and play the OK feedback (in readout mode the reader plays none
 * itself). A card out before the reply drops the read: a later reply for that
 * card is ignored and gets no feedback. One read per insertion.
 *
 * With `confirmReads`, the feedback waits until the cardRead listener calls
 * `confirm`, so an app that stores the read first beeps only once it is saved.
 * The reader sets no time limit; without a confirm it stays silent, and the
 * card is read again when it goes back in.
 */
export class ReaderBt {
  private readonly link: GattLink;
  private readonly confirmReads: boolean;
  private readonly listeners: Listeners = {
    cardInserted: new Set(),
    cardRead: new Set(),
    cardRemoved: new Set(),
    error: new Set(),
  };
  private readonly reassembler = new Reassembler();
  /** Card whose readout is requested and not yet received. */
  private reading: number | undefined;
  /** Card read during its current insertion. */
  private read: number | undefined;

  constructor(link: GattLink, opts: { confirmReads?: boolean } = {}) {
    this.link = link;
    this.confirmReads = opts.confirmReads ?? false;
  }

  async start(): Promise<void> {
    this.link.onDisconnect(() => this.reset());
    await this.link.subscribe(READER_BT_UUID.cardState, (b) => this.onCardState(b));
    await this.link.subscribe(READER_BT_UUID.cardData, (b) => this.onCardData(b));
  }

  on<E extends keyof ReaderBtEvents>(event: E, listener: ReaderBtEvents[E]): this {
    this.listeners[event].add(listener);
    return this;
  }

  off<E extends keyof ReaderBtEvents>(event: E, listener: ReaderBtEvents[E]): this {
    this.listeners[event].delete(listener);
    return this;
  }

  /** Flash and beep: ok (two short) or error (four short). */
  feedback(type: keyof typeof FEEDBACK): Promise<void> {
    return this.link.write(
      READER_BT_UUID.cardData,
      encodeMessage(READER_BT_MSG.feedback, [FEEDBACK[type]])
    );
  }

  private emit<E extends keyof ReaderBtEvents>(event: E, ...args: Parameters<ReaderBtEvents[E]>) {
    for (const l of this.listeners[event]) (l as (...a: typeof args) => void)(...args);
  }

  private reset(): void {
    this.reassembler.reset();
    this.reading = undefined;
    this.read = undefined;
  }

  private onCardState(bytes: Uint8Array): void {
    let state;
    try {
      const { id, payload } = splitMessage(bytes);
      if (id !== READER_BT_MSG.cardStateChange) return;
      state = decodeCardState(payload);
    } catch (err) {
      this.emit('error', err as Error);
      return;
    }
    const { cardNumber, inserted } = state;
    if (!inserted) {
      if (this.reading === cardNumber) this.reading = undefined;
      if (this.read === cardNumber) this.read = undefined;
      this.emit('cardRemoved', cardNumber);
      return;
    }
    if (this.reading === cardNumber || this.read === cardNumber) return;
    this.reading = cardNumber;
    this.read = undefined;
    this.emit('cardInserted', cardNumber);
    this.link
      .write(
        READER_BT_UUID.cardData,
        encodeMessage(
          isSiacNumber(cardNumber)
            ? READER_BT_MSG.cardReadoutComplete
            : READER_BT_MSG.cardReadoutMinimal
        )
      )
      .catch((err: Error) => {
        if (this.reading === cardNumber) this.reading = undefined;
        this.emit('error', err);
      });
  }

  private onCardData(bytes: Uint8Array): void {
    const result = this.reassembler.push(bytes);
    if (result === null) return;
    if ('error' in result) {
      this.emit('error', new Error(`Reader BT: ${result.error}`));
      return;
    }
    let readout: ReaderBtReadout;
    try {
      readout = decodeReadout(result.message);
    } catch (err) {
      this.emit('error', err as Error);
      return;
    }
    // A reply for a card that was pulled, or never requested, is not used.
    if (readout.cardNumber !== this.reading) return;
    this.reading = undefined;
    this.read = readout.cardNumber;
    let confirmed = false;
    const confirm: ConfirmRead = (type = 'ok') => {
      if (confirmed) return Promise.resolve();
      confirmed = true;
      return this.feedback(type);
    };
    this.emit('cardRead', readout, confirm);
    if (!this.confirmReads) confirm().catch((err: Error) => this.emit('error', err));
  }
}

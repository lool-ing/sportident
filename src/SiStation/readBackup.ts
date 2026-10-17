// Authored for lool. Not ported from upstream.
//
// BSF8 check-unit backup memory readout protocol.
//
// Implements readBackupMemory: reads the check-unit's backup memory by
// issuing GET_SYS_VAL to get the memory pointer, then looping GET_BACKUP
// in 128-byte blocks until the pointer is consumed.
//
// Source: pcprog5.pdf §3 + BSx7_8_readbackup.txt (backup record layout).
// Re-authored against the public spec — not ported from any prior code.
//
// STRIDE DoS threat (loop cap): MAX_ITERATIONS = 512 caps the
// loop to prevent an infinite loop on a malformed memory pointer from the
// hardware.

import { proto } from '../constants.ts';
import { arr2cardNumber } from '../siProtocol.ts';
import type { ISiStation } from './ISiStation.ts';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Size of each GET_BACKUP response block in bytes. */
export const BLOCK_SIZE = 128;

/** Hard cap on GET_BACKUP iterations (DoS mitigation).
 * BSF8 has max 32 KB backup memory → 256 blocks; we cap at 2× for safety. */
export const MAX_ITERATIONS = 512;

// Backup memory address range (pcprog §3.1, BSx7/8). The lowest usable backup
// address is 0x100; the GET_SYS_VAL backup-pointer is the ABSOLUTE next-free
// address, so the data spans [0x100, pointer).
const BACKUP_BASE_ADDRESS = 0x100;

// GET_SYS_VAL backup-pointer request: address 0x1C, length 0x07 (pcprog §3.1).
// The 7 data bytes that come back are `EP3 EP2 xx xx xx EP1 EP0`; the pointer is
// the big-endian uint32 EP3 EP2 EP1 EP0.
const BACKUP_POINTER_ADDR = 0x1c;
const BACKUP_POINTER_LEN = 0x07;

// Response FRAME header lengths. station.sendMessage() returns frames shaped
// `[cmd, len, ...payload]` (the multiplexer strips STX/CRC/ETX). For both
// GET_SYS_VAL and GET_BACKUP the payload begins with a station/address header
// that must be skipped before the real data:
//   GET_SYS_VAL pointer reply payload: CN1 CN0 ADDR + 7 data bytes   → skip 3
//   GET_BACKUP  reply payload:         CN1 CN0 ADR2 ADR1 ADR0 + data → skip 5
const SYSVAL_PAYLOAD_HEADER = 3; // CN1, CN0, ADDR-echo
const BACKUP_PAYLOAD_HEADER = 5; // CN1, CN0, ADR2, ADR1, ADR0
const FRAME_HEADER = 2; // cmd, len

// Per-record layout within the backup data (8-byte records, hardware-verified
// 2026-06-01 — see __fixtures__/coupled-backup-golden.md):
//   bytes 0..2 : SI card number (3-byte field, decoded via arr2cardNumber)
//   bytes 3..4 : fixed 0x69 0x69 marker
//   bytes 5..7 : punch time (monotonic)

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single record read from the check-unit's backup memory. */
export interface BackupRecord {
  /** SI card number (non-zero; zero-card records are skipped). Decoded with the
   * canonical arr2cardNumber so it matches the live card-read path. */
  cardNumber: number;
  /** Raw 3-byte punch-time field (bytes 5..7 of the record) as a big-endian
   * integer. Monotonic across a block; used for ordering, not wall-clock. */
  rawTime: number;
}

// ---------------------------------------------------------------------------
// Frame parsers (hardware-verified — readBackupHardware.test.ts)
// ---------------------------------------------------------------------------

/**
 * Parse a GET_SYS_VAL backup-pointer response FRAME into the absolute next-free
 * backup address. Frame shape: `[cmd, len, CN1, CN0, ADDR, EP3, EP2, xx, xx,
 * xx, EP1, EP0]`. The pointer is big-endian `EP3 EP2 EP1 EP0`.
 */
export function parseBackupPointerFrame(frame: number[]): number {
  // payload = frame after [cmd, len]; data = payload after [CN1, CN0, ADDR].
  const data = frame.slice(FRAME_HEADER + SYSVAL_PAYLOAD_HEADER);
  if (data.length < 7) return 0;
  const ep3 = data[0] ?? 0;
  const ep2 = data[1] ?? 0;
  const ep1 = data[5] ?? 0;
  const ep0 = data[6] ?? 0;
  return ((ep3 << 24) | (ep2 << 16) | (ep1 << 8) | ep0) >>> 0;
}

/**
 * Parse a GET_BACKUP response FRAME into BackupRecord[]. Frame shape:
 * `[cmd, len, CN1, CN0, ADR2, ADR1, ADR0, ...data]`. The data is a run of
 * 8-byte records; card number = bytes 0..2 via arr2cardNumber; bytes 5..7 are
 * the punch time. Zero-card records (empty slots) are skipped; a trailing
 * partial record is ignored.
 */
export function parseBackupDataFrame(frame: number[]): BackupRecord[] {
  const data = frame.slice(FRAME_HEADER + BACKUP_PAYLOAD_HEADER);
  return parseBackupBlock(new Uint8Array(data), proto.REC_LEN);
}

// ---------------------------------------------------------------------------
// Pure parsing helpers (exported for unit tests)
// ---------------------------------------------------------------------------

/**
 * Parse the DATA portion of a GET_BACKUP block into BackupRecord[]. `block` is
 * the record bytes only (header already stripped by parseBackupDataFrame).
 *
 * Layout (hardware-verified 2026-06-01, BSF8 check unit — see
 * __fixtures__/coupled-backup-golden.md):
 *   bytes 0..2 : SI card number (3-byte field). Decoded with arr2cardNumber
 *     (LSB-first) so legacy SI5 numbers match the live card-read path — plain
 *     big-endian is WRONG for cards whose high byte ≤ 4 (e.g. 0x01413a is
 *     116698, not 82234).
 *   bytes 3..4 : fixed 0x69 0x69 marker (not interpreted).
 *   bytes 5..7 : punch time, big-endian (monotonic; ordering only).
 * Records with cardNumber 0 are empty slots and are skipped. A trailing partial
 * record (fewer than recLen bytes) is ignored.
 *
 * @param block  Record bytes from the GET_BACKUP response (no header).
 * @param recLen Bytes per record (proto.REC_LEN = 8).
 */
export function parseBackupBlock(block: Uint8Array, recLen: number): BackupRecord[] {
  const records: BackupRecord[] = [];
  const count = Math.floor(block.length / recLen);
  for (let i = 0; i < count; i++) {
    const offset = i * recLen;
    if (offset + recLen > block.length) break;

    // Card number: 3-byte field at bytes 0..2, big-endian on the wire. The
    // canonical arr2cardNumber takes LSB-first, so reverse the three bytes.
    const b0 = block[offset]!;
    const b1 = block[offset + 1]!;
    const b2 = block[offset + 2]!;
    if (b0 === 0 && b1 === 0 && b2 === 0) continue; // empty slot
    const cardNumber = arr2cardNumber([b2, b1, b0]) ?? 0;
    if (cardNumber === 0) continue;

    // Punch time: 3-byte field at bytes 5..7, big-endian. Used only for
    // ordering within a block, not as a wall-clock time.
    const rawTime =
      ((block[offset + 5]! << 16) | (block[offset + 6]! << 8) | block[offset + 7]!) >>> 0;

    records.push({ cardNumber, rawTime });
  }
  return records;
}

// ---------------------------------------------------------------------------
// Main readout function
// ---------------------------------------------------------------------------

/**
 * Read all backup records from the check-unit's backup memory.
 *
 * Protocol (pcprog §3.1, hardware-verified):
 *   1. GET_SYS_VAL[0x1C, 0x07] → the absolute next-free backup address.
 *   2. Walk GET_BACKUP from BACKUP_BASE_ADDRESS (0x100) up to that pointer in
 *      BLOCK_SIZE (128-byte) reads, parsing 8-byte records out of each.
 *   3. Cap at MAX_ITERATIONS reads (DoS mitigation); set overflow if
 *      the cap is hit.
 *
 * @param station  Any ISiStation (SiMainStation or test double).
 * @returns Object with parsed records and flags.
 */
export async function readBackupMemory(station: ISiStation): Promise<{
  records: BackupRecord[];
  overflow: boolean;
}> {
  // station.sendMessage() returns each response as the full frame
  // `[cmd, len, ...payload]` (the multiplexer reconstructs it that way; see
  // BaseSiStation.readInfo which relies on the same shape). The frame parsers
  // below consume that directly.

  // Step 1: read the backup pointer (absolute next-free address).
  const ptrResponses = await station.sendMessage(
    { command: proto.cmd.GET_SYS_VAL, parameters: [BACKUP_POINTER_ADDR, BACKUP_POINTER_LEN] },
    1
  );
  const pointer = parseBackupPointerFrame(ptrResponses[0] ?? []);

  if (pointer <= BACKUP_BASE_ADDRESS) {
    // Empty backup memory (next-free address is at or below the base).
    return { records: [], overflow: false };
  }

  // Step 2: walk [BASE, pointer) in BLOCK_SIZE reads.
  const totalBytes = pointer - BACKUP_BASE_ADDRESS;
  const blocksNeeded = Math.ceil(totalBytes / BLOCK_SIZE);
  const loopCapped = blocksNeeded > MAX_ITERATIONS;
  const blockCount = loopCapped ? MAX_ITERATIONS : blocksNeeded;

  const allRecords: BackupRecord[] = [];
  for (let i = 0; i < blockCount; i++) {
    const address = BACKUP_BASE_ADDRESS + i * BLOCK_SIZE;
    const addrHi = (address >>> 16) & 0xff;
    const addrMid = (address >>> 8) & 0xff;
    const addrLo = address & 0xff;
    const backupResponses = await station.sendMessage(
      { command: proto.cmd.GET_BACKUP, parameters: [addrHi, addrMid, addrLo, BLOCK_SIZE] },
      1
    );
    allRecords.push(...parseBackupDataFrame(backupResponses[0] ?? []));
  }

  return { records: allRecords, overflow: loopCapped };
}

// ---------------------------------------------------------------------------
// Coupled (inductive) backup readout
// ---------------------------------------------------------------------------

/**
 * Thrown when the FIRST forwarded command (the backup-pointer read) never gets
 * a reply through the inductive link. The overwhelmingly common cause is a
 * SLEEPING check unit: SI stations run on battery and sleep, and §2.5 requires
 * the slaved station to be in active mode for coupling to sync. The master
 * cannot wake it through the coil — the operator must dip a card into the check
 * unit to wake it, then retry. The route maps this to a friendly 503 so the UI
 * can prompt the operator instead of showing a raw timeout.
 */
export class CoupledStationAsleepError extends Error {
  constructor(command: number, attempts: number) {
    super(
      `coupled read: the check unit did not respond after ${attempts} attempts ` +
        `(command 0x${command.toString(16)}). The station is most likely asleep — ` +
        `dip an SI card into the check unit to wake it, then read again.`
    );
    this.name = 'CoupledStationAsleepError';
  }
}

/** Options for readCoupledBackupMemory (all optional; defaults match §2.5). */
export interface CoupledReadOptions {
  /** Max attempts per forwarded command before giving up (§2.5: "Repeat
   * number should be 3...5"). Default 5. */
  maxRetries?: number;
  /** Base inter-attempt delay in ms; the actual delay grows per attempt
   * (§2.5: "delay time should vary in steps of some 10 ms"). Default 15. */
  retryDelayMs?: number;
  /** Per-attempt response timeout in ms passed to sendMessage. Kept short so a
   * dropped NAK (which the multiplexer silently swallows) fails fast and the
   * retry loop can re-issue. Default 1500. */
  attemptTimeoutMs?: number;
  /** Injectable sleep (tests pass a no-op). Default: real setTimeout. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Send a forwarded command with the §2.5 retry-on-failure loop.
 *
 * The first instruction forwarded to a freshly-coupled station starts the
 * inductive synchronisation and frequently NAKs or simply doesn't answer.
 * The multiplexer drops bare NAK frames silently, so a NAK surfaces here as a
 * SendTimeoutError. Both rejection and timeout are treated identically: wait a
 * short, growing delay and retry, up to maxRetries attempts.
 */
async function sendWithRetry(
  station: ISiStation,
  message: { command: number; parameters: number[] },
  opts: Required<Pick<CoupledReadOptions, 'maxRetries' | 'retryDelayMs' | 'attemptTimeoutMs'>> & {
    sleep: (ms: number) => Promise<void>;
  },
  /** When true, an exhausted retry budget throws CoupledStationAsleepError
   * (used for the FIRST forwarded command, where no reply ≈ asleep station). */
  asleepOnExhaustion = false
): Promise<number[][]> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < opts.maxRetries; attempt++) {
    if (attempt > 0) {
      // Growing delay in ~10ms steps (§2.5).
      await opts.sleep(opts.retryDelayMs * attempt);
    }
    try {
      return await station.sendMessage(message, 1, opts.attemptTimeoutMs);
    } catch (err) {
      lastErr = err;
    }
  }
  if (asleepOnExhaustion) {
    throw new CoupledStationAsleepError(message.command, opts.maxRetries);
  }
  throw new Error(
    `coupled read: command 0x${message.command.toString(16)} failed after ${opts.maxRetries} attempts ` +
      `(transparent-mode sync to the coupled station never completed): ${
        lastErr instanceof Error ? lastErr.message : String(lastErr)
      }`
  );
}

/**
 * Read backup memory from a BSFx check unit that is INDUCTIVELY COUPLED on top
 * of a BSMx master station ("mini reader"), per PC Programmer's Guide v5 §2.5.
 *
 * Sequence:
 *   1. SET_MS(P_MS_REMOTE = 0x53) — switch the master into transparent mode so
 *      all subsequent commands are forwarded to the coupled station.
 *   2. GET_SYS_VAL + GET_BACKUP loop (identical to direct readBackupMemory),
 *      each wrapped in the §2.5 retry-on-NAK loop because inductive sync is
 *      flaky on the first forwarded instructions.
 *   3. SET_MS(P_MS_DIRECT = 0x4D) in a finally — ALWAYS restore the master to
 *      direct mode so the next live card read works, even if the backup read
 *      throws.
 *
 * @param station  The master station (SiMainStation) the check unit sits on.
 * @param options  Retry/timing knobs (see CoupledReadOptions).
 */
export async function readCoupledBackupMemory(
  station: ISiStation,
  options: CoupledReadOptions = {}
): Promise<{ records: BackupRecord[]; overflow: boolean }> {
  const retryOpts = {
    maxRetries: options.maxRetries ?? 6,
    retryDelayMs: options.retryDelayMs ?? 20,
    attemptTimeoutMs: options.attemptTimeoutMs ?? 1200,
    sleep: options.sleep ?? defaultSleep,
  };

  // Step 1: switch master → transparent/slave mode. This itself can need a
  // retry; the master echoes the M/S byte back.
  await sendWithRetry(
    station,
    { command: proto.cmd.SET_MS, parameters: [proto.P_MS_REMOTE] },
    retryOpts
  );

  try {
    // Step 2a: read the backup pointer (absolute next-free address), forwarded
    // to the coupled station. GET_SYS_VAL[0x1C, 0x07] per pcprog §3.1. This is
    // the FIRST command that actually reaches the coupled station — if it never
    // answers, the unit is asleep, so surface the typed asleep error for a
    // friendly "dip a card to wake it" prompt.
    const ptrResponses = await sendWithRetry(
      station,
      { command: proto.cmd.GET_SYS_VAL, parameters: [BACKUP_POINTER_ADDR, BACKUP_POINTER_LEN] },
      retryOpts,
      true // asleepOnExhaustion
    );
    const pointer = parseBackupPointerFrame(ptrResponses[0] ?? []);

    if (pointer <= BACKUP_BASE_ADDRESS) {
      return { records: [], overflow: false };
    }

    // Step 2b: walk [BASE, pointer) in BLOCK_SIZE reads.
    const totalBytes = pointer - BACKUP_BASE_ADDRESS;
    const blocksNeeded = Math.ceil(totalBytes / BLOCK_SIZE);
    const loopCapped = blocksNeeded > MAX_ITERATIONS;
    const blockCount = loopCapped ? MAX_ITERATIONS : blocksNeeded;

    const allRecords: BackupRecord[] = [];
    for (let i = 0; i < blockCount; i++) {
      const address = BACKUP_BASE_ADDRESS + i * BLOCK_SIZE;
      const addrHi = (address >>> 16) & 0xff;
      const addrMid = (address >>> 8) & 0xff;
      const addrLo = address & 0xff;
      const backupResponses = await sendWithRetry(
        station,
        { command: proto.cmd.GET_BACKUP, parameters: [addrHi, addrMid, addrLo, BLOCK_SIZE] },
        retryOpts
      );
      allRecords.push(...parseBackupDataFrame(backupResponses[0] ?? []));
    }

    return { records: allRecords, overflow: loopCapped };
  } finally {
    // Step 3: ALWAYS restore direct/master mode so live card reads resume.
    // Best-effort — if even this fails we don't want to mask the original
    // error, so swallow any restore failure.
    try {
      await sendWithRetry(
        station,
        { command: proto.cmd.SET_MS, parameters: [proto.P_MS_DIRECT] },
        retryOpts
      );
    } catch {
      /* best-effort restore; original error (if any) propagates */
    }
  }
}

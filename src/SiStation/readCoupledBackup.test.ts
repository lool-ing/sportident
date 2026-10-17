// Authored for lool. Not ported from upstream.
//
// Tests for readCoupledBackupMemory — reading the backup memory of a BSFx
// check unit that is INDUCTIVELY COUPLED on top of a BSMx master ("mini
// reader"), per SPORTident PC Programmer's Guide v5 §2.5.
//
// All tests use a programmable mock station; no real hardware required.
//
// The coupling sequence under test:
//   1) SET_MS(0xF0) with P_MS_REMOTE (0x53) — switch master to transparent
//      mode so subsequent commands are forwarded to the coupled station.
//   2) GET_SYS_VAL + GET_BACKUP loop (forwarded to the coupled station).
//   3) SET_MS(0xF0) with P_MS_DIRECT (0x4D) — restore master mode (finally).
//
// §2.5 mandates a retry loop on NAK because the first forwarded instruction
// starts the inductive sync and frequently fails. A NAK rejects the command,
// silence hits the short per-attempt timeout; the retry helper treats both
// timeout and rejection uniformly as "retry".

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { proto } from '../constants.ts';
import { readCoupledBackupMemory, parseBackupDataFrame, type BackupRecord } from './readBackup.ts';
import type { ISiStation } from './ISiStation.ts';
import type { SiMessage } from '../siProtocol.ts';

// ---------------------------------------------------------------------------
// Fixtures — build real frame shapes [cmd, len, ...payload] (see
// readBackup.test.ts / readBackupHardware.test.ts for the layout rationale).
// ---------------------------------------------------------------------------

import { cardNumber2arr } from '../siProtocol.ts';

function cardBytes(cn: number): [number, number, number] {
  const [b0, b1, b2] = cardNumber2arr(cn);
  return [b2 as number, b1 as number, b0 as number];
}

/** GET_BACKUP response FRAME: [cmd, len, CN1, CN0, ADR2, ADR1, ADR0, ...data]. */
function backupFrame(cards: number[]): number[] {
  const data: number[] = [];
  for (let i = 0; i < cards.length; i++) {
    const [a, b, c] = cardBytes(cards[i]!);
    data.push(a, b, c, 0x69, 0x69, 0x00, 0x00, i & 0xff);
  }
  while (data.length < 128) data.push(0x00);
  const payload = [0x00, 0x02, 0x00, 0x01, 0x00, ...data];
  return [proto.cmd.GET_BACKUP, payload.length & 0xff, ...payload];
}

/** GET_SYS_VAL pointer response FRAME for an absolute pointer. */
function pointerFrame(pointer: number): number[] {
  const ep3 = (pointer >>> 24) & 0xff;
  const ep2 = (pointer >>> 16) & 0xff;
  const ep1 = (pointer >>> 8) & 0xff;
  const ep0 = pointer & 0xff;
  const payload = [0x00, 0x02, 0x1c, ep3, ep2, 0x00, 0x00, 0x00, ep1, ep0];
  return [proto.cmd.GET_SYS_VAL, payload.length & 0xff, ...payload];
}

// ---------------------------------------------------------------------------
// Programmable mock station
// ---------------------------------------------------------------------------

interface MockCall {
  command: number;
  parameters: number[];
}

/** A scripted response: either a frame to resolve, or a sentinel to reject
 * (simulating a dropped-NAK → per-attempt timeout). */
type Scripted = { kind: 'frame'; frame: number[] } | { kind: 'reject'; message: string };

/**
 * Mock that dispatches by command using per-command response queues. Each
 * call to a command consumes the next scripted response for that command;
 * when a command's queue is exhausted the LAST scripted response repeats
 * (so GET_BACKUP can be scripted once and reused across blocks).
 */
function makeMockStation(script: { [command: number]: Scripted[] }): {
  station: ISiStation;
  calls: MockCall[];
} {
  const calls: MockCall[] = [];
  const cursors = new Map<number, number>();
  const station: ISiStation = {
    sendMessage(message: SiMessage): Promise<number[][]> {
      if (!('command' in message)) {
        return Promise.reject(new Error('MockStation: expected a command-style SiMessage'));
      }
      calls.push({ command: message.command, parameters: message.parameters });
      const queue = script[message.command];
      if (!queue || queue.length === 0) {
        return Promise.reject(
          new Error(`MockStation: no script for command 0x${message.command.toString(16)}`)
        );
      }
      const idx = cursors.get(message.command) ?? 0;
      const entry = queue[Math.min(idx, queue.length - 1)]!;
      cursors.set(message.command, idx + 1);
      if (entry.kind === 'reject') return Promise.reject(new Error(entry.message));
      return Promise.resolve([entry.frame]);
    },
  };
  return { station, calls };
}

/** No-op sleep so retry tests don't actually wait. */
const noSleep = (): Promise<void> => Promise.resolve();

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('coupled backup', () => {
  test('Test 1: brackets the read with SET_MS(0x53) then SET_MS(0x4D)', async () => {
    const pointer = 0x100 + 128; // one block beyond base
    const { station, calls } = makeMockStation({
      [proto.cmd.SET_MS]: [{ kind: 'frame', frame: [0x4d] }],
      [proto.cmd.GET_SYS_VAL]: [{ kind: 'frame', frame: pointerFrame(pointer) }],
      [proto.cmd.GET_BACKUP]: [{ kind: 'frame', frame: backupFrame([1083339, 7524126]) }],
    });

    const result = await readCoupledBackupMemory(station, { sleep: noSleep });

    // First wire command must be SET_MS with the REMOTE (0x53) parameter.
    assert.equal(calls[0]!.command, proto.cmd.SET_MS);
    assert.equal(calls[0]!.parameters[0], proto.P_MS_REMOTE);
    // Last wire command must be SET_MS with the DIRECT (0x4D) parameter.
    const last = calls[calls.length - 1]!;
    assert.equal(last.command, proto.cmd.SET_MS);
    assert.equal(last.parameters[0], proto.P_MS_DIRECT);
    // Cards came back.
    const cns = result.records.map((r: BackupRecord) => r.cardNumber);
    assert.ok(cns.includes(1083339));
    assert.ok(cns.includes(7524126));
  });

  test('Test 2: retries a forwarded command on transient failure (NAK/timeout)', async () => {
    const pointer = 0x100 + 128;
    const { station, calls } = makeMockStation({
      [proto.cmd.SET_MS]: [{ kind: 'frame', frame: [0x4d] }],
      // First GET_SYS_VAL attempt fails (inductive sync not yet established),
      // second succeeds — exactly the §2.5 scenario.
      [proto.cmd.GET_SYS_VAL]: [
        { kind: 'reject', message: 'simulated NAK/timeout' },
        { kind: 'frame', frame: pointerFrame(pointer) },
      ],
      [proto.cmd.GET_BACKUP]: [{ kind: 'frame', frame: backupFrame([320541]) }],
    });

    const result = await readCoupledBackupMemory(station, { sleep: noSleep });

    const sysValCalls = calls.filter((c) => c.command === proto.cmd.GET_SYS_VAL);
    assert.equal(sysValCalls.length, 2, 'should retry GET_SYS_VAL once');
    assert.equal(result.records[0]!.cardNumber, 320541);
  });

  test('Test 3: throws after exhausting retries, but still restores direct mode', async () => {
    const { station, calls } = makeMockStation({
      [proto.cmd.SET_MS]: [{ kind: 'frame', frame: [0x4d] }],
      [proto.cmd.GET_SYS_VAL]: [{ kind: 'reject', message: 'always fails' }],
      [proto.cmd.GET_BACKUP]: [{ kind: 'frame', frame: [] }],
    });

    await assert.rejects(
      readCoupledBackupMemory(station, { sleep: noSleep, maxRetries: 3 }),
      /coupled|transparent|backup/i
    );

    // The finally block must have restored direct mode despite the throw.
    const last = calls[calls.length - 1]!;
    assert.equal(last.command, proto.cmd.SET_MS);
    assert.equal(last.parameters[0], proto.P_MS_DIRECT);
    // Exactly maxRetries GET_SYS_VAL attempts.
    assert.equal(calls.filter((c) => c.command === proto.cmd.GET_SYS_VAL).length, 3);
  });

  test('Test 4: empty coupled memory (pointer at base) returns no records, still restores', async () => {
    const { station, calls } = makeMockStation({
      [proto.cmd.SET_MS]: [{ kind: 'frame', frame: [0x4d] }],
      [proto.cmd.GET_SYS_VAL]: [{ kind: 'frame', frame: pointerFrame(0x100) }],
      [proto.cmd.GET_BACKUP]: [{ kind: 'frame', frame: backupFrame([]) }],
    });

    const result = await readCoupledBackupMemory(station, { sleep: noSleep });
    assert.equal(result.records.length, 0);
    // No GET_BACKUP should have been sent (pointer at base short-circuits).
    assert.equal(calls.filter((c) => c.command === proto.cmd.GET_BACKUP).length, 0);
    // Direct mode restored.
    const last = calls[calls.length - 1]!;
    assert.equal(last.parameters[0], proto.P_MS_DIRECT);
  });

  test('Test 5: parseBackupDataFrame works on a coupled-read frame (sanity)', () => {
    const records = parseBackupDataFrame(backupFrame([999001]));
    assert.equal(records[0]!.cardNumber, 999001);
  });
});

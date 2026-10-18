// Authored for lool. Not ported from upstream.
//
// SiTargetMultiplexer regression tests focused on send-queue lifecycle.
// Specifically
// a timed-out SiSendTask must be removed from `pendingSendTasks` so the next
// command can pair with its response. Before the fix, the timed-out task stayed
// at the head of the queue and absorbed the next station response, causing the
// second command to time out too.
//
// See NOTICE.md for cumulative attribution.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { render } from '../siProtocol.ts';
import { proto } from '../constants.ts';
import { SendTimeoutError } from '../transport/errors.ts';
import type { ISerialTransport } from '../transport/ISerialTransport.ts';
import { SiTargetMultiplexer } from './SiTargetMultiplexer.ts';

// Minimal in-memory transport: records every `send`, never replies on its own.
// Tests use `inject(bytes)` to drive a station response, after the test has
// already let the first command time out.
class SilentTransport extends EventEmitter implements ISerialTransport {
  public sends: number[][] = [];
  open(): Promise<void> {
    return Promise.resolve();
  }
  send(bytes: number[]): Promise<void> {
    this.sends.push(bytes);
    return Promise.resolve();
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
  inject(bytes: number[]): void {
    setImmediate(() => this.emit('data', bytes));
  }
}

const renderFrame = (command: number, parameters: number[]): number[] =>
  render({ command, parameters });

/** The first write hangs until `release()`, so later commands wait in the send
 * queue (a slow drain on the real port). */
class HeldTransport extends SilentTransport {
  release: () => void = () => undefined;
  override send(bytes: number[]): Promise<void> {
    this.sends.push(bytes);
    if (this.sends.length > 1) return Promise.resolve();
    return new Promise((resolve) => (this.release = resolve));
  }
}

describe('SiTargetMultiplexer: send-queue lifecycle', () => {
  test('a timed-out task is removed so the next command can pair with its response', async () => {
    const transport = new SilentTransport();
    const mux = new SiTargetMultiplexer(transport);

    // Command 1: GET_SYS_VAL with a short timeout. Transport never replies, so
    // the task rejects with SendTimeoutError.
    const first = mux.sendMessage(
      { command: proto.cmd.GET_SYS_VAL, parameters: [0x00, 0x80] },
      1,
      /* timeoutMs */ 50
    );
    let firstTimedOut = false;
    try {
      await first;
    } catch (err) {
      firstTimedOut = err instanceof SendTimeoutError;
    }
    assert.strictEqual(firstTimedOut, true, 'first command should time out');

    // Drain the microtask queue so the finally() cleanup runs.
    await new Promise((r) => setImmediate(r));

    // Command 2: GET_SI5. Now inject the matching response — the dispatch path
    // should route this to the SECOND task, not the dead first task.
    const second = mux.sendMessage(
      { command: proto.cmd.GET_SI5, parameters: [] },
      1,
      /* timeoutMs */ 200
    );

    // Give the send-chain a tick to actually call transport.send, THEN inject.
    await new Promise((r) => setImmediate(r));
    transport.inject(renderFrame(proto.cmd.GET_SI5, [0x00, 0x0a, 0xaa]));

    let secondTimedOut = false;
    let secondResponse: number[][] | undefined;
    try {
      secondResponse = await second;
    } catch (err) {
      secondTimedOut = err instanceof SendTimeoutError;
    }

    // Before the fix: secondTimedOut=true (the response was absorbed by the
    // stale timed-out head task). After: secondTimedOut=false; the response
    // arrives at the live second task.
    assert.strictEqual(secondTimedOut, false, 'second command must NOT time out');
    assert.ok(secondResponse, 'second command resolved with a response');
    assert.strictEqual(secondResponse![0]?.[0], proto.cmd.GET_SI5, 'response is a GET_SI5 frame');

    await mux.close();
  });

  test('a bare NAK fails the pending command at once', async () => {
    const transport = new SilentTransport();
    const mux = new SiTargetMultiplexer(transport);
    const pending = mux.sendMessage({ command: proto.cmd.GET_SI8, parameters: [0x04] }, 1, 1_000);
    await new Promise((r) => setImmediate(r));
    transport.inject([proto.NAK]);
    await assert.rejects(pending, /NAK/);

    // The next command pairs with its own reply.
    const next = mux.sendMessage({ command: proto.cmd.GET_SI8, parameters: [0x00] }, 1, 200);
    await new Promise((r) => setImmediate(r));
    transport.inject(renderFrame(proto.cmd.GET_SI8, [0x00, 0x0a, 0x00]));
    assert.strictEqual((await next)[0]?.[4], 0x00);
    await mux.close();
  });

  for (const [how, abort] of [
    [
      'aborted',
      (mux: SiTargetMultiplexer) => mux._abortAllPendingSends('', new Error('card removed')),
    ],
    ['timed out', () => new Promise((r) => setTimeout(r, 50))],
  ] as const) {
    test(`a command ${how} while waiting in the send queue is never written`, async () => {
      const transport = new HeldTransport();
      const mux = new SiTargetMultiplexer(transport);
      const page0 = mux.sendMessage({ command: proto.cmd.GET_SI8, parameters: [0x00] }, 1, 1_000);
      const page4 = mux.sendMessage({ command: proto.cmd.GET_SI8, parameters: [0x04] }, 1, 20);
      page0.catch(() => undefined);
      await new Promise((r) => setImmediate(r)); // page 0 is now stuck in the write
      await assert.rejects(Promise.all([page4, abort(mux)]));
      transport.release();
      await new Promise((r) => setImmediate(r));
      assert.deepEqual(
        transport.sends.map((c) => c[4]),
        [0x00],
        'only page 0 reached the wire'
      );
      await mux.close();
    });
  }

  test('a partial frame left by a timed-out command is dropped; the next command gets its own reply', async () => {
    const transport = new SilentTransport();
    const mux = new SiTargetMultiplexer(transport);
    const page4 = (fill: number): number[] =>
      renderFrame(proto.cmd.GET_SI8, [0x00, 0x0a, 0x04, ...new Array<number>(128).fill(fill)]);
    const first = mux.sendMessage({ command: proto.cmd.GET_SI8, parameters: [0x04] }, 1, 50);
    transport.inject([0x02, 0xef, 0xff, ...page4(0x11)]); // noise swallows the reply
    await assert.rejects(first, SendTimeoutError);
    const again = mux.sendMessage({ command: proto.cmd.GET_SI8, parameters: [0x04] }, 1, 200);
    transport.inject(page4(0x22));
    assert.strictEqual((await again)[0]?.[5], 0x22, "the retry's own reply, not the old one");
    await mux.close();
  });

  test('a good reply split over three deliveries still pairs', async () => {
    const transport = new SilentTransport();
    const mux = new SiTargetMultiplexer(transport);
    const reply = renderFrame(proto.cmd.GET_SI8, [
      0x00,
      0x0a,
      0x00,
      ...new Array<number>(128).fill(0x33),
    ]);
    const pending = mux.sendMessage({ command: proto.cmd.GET_SI8, parameters: [0x00] }, 1, 200);
    const half = Math.floor(reply.length / 2);
    for (const piece of [reply.slice(0, 1), reply.slice(1, half), reply.slice(half)]) {
      transport.inject(piece);
      await new Promise((r) => setTimeout(r, 5));
    }
    assert.strictEqual((await pending)[0]?.[5], 0x33);
    await mux.close();
  });
});

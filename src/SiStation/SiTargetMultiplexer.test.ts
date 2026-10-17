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
});

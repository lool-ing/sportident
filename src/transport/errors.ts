// Authored for lool. Not ported from upstream.
// Shared transport-layer errors. Imported by SerialTransport.ts (post-close send rejection)
// AND by SiSendTask.ts (mid-flight abort) — defined here so neither file imports from the other.

export class DeviceClosedError extends Error {
  constructor(reason?: string) {
    super(reason ?? 'Device closed');
    this.name = 'DeviceClosedError';
  }
}

export class SendTimeoutError extends Error {
  constructor(command: number, timeoutMs: number) {
    super(
      `Send timed out after ${timeoutMs}ms (command 0x${command.toString(16).padStart(2, '0').toUpperCase()})`
    );
    this.name = 'SendTimeoutError';
  }
}

/** The station refused the command with a bare NAK (eg no card to read). */
export class NakError extends Error {
  constructor() {
    super('NAK');
    this.name = 'NakError';
  }
}

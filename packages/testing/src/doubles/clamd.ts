// A clamd stand-in over TCP, for E2E_STACK=native. Speaks the commands the upload path uses: PING, VERSION and
// INSTREAM, each in the null-terminated `z` form or the newline `n` form. A stream that contains the EICAR test string is
// reported as infected; every other stream is clean. For tests and local runs only: never import it from production code.
import { createServer, type Server, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';

// Built from parts so this file is not itself flagged by a virus scanner on a developer machine.
export const EICAR = ['X5O!P%@AP[4\\PZX54(P^)7CC)7}$', 'EICAR-STANDARD-ANTIVIRUS-TEST-FILE!', '$H+H*'].join('');
export const EICAR_SIGNATURE = 'Eicar-Test-Signature';
const EICAR_BYTES = Buffer.from(EICAR, 'latin1');

export interface MockClamdOptions {
  port?: number;
  host?: string;
  /** Largest stream accepted, as clamd's StreamMaxLength. Default 300 MiB (infra/clamav/clamd.conf). */
  streamMaxLength?: number;
  version?: string;
}

export interface MockClamd {
  port: number;
  host: string;
  /** Number of INSTREAM scans done, for assertions. */
  scans(): number;
  close(): Promise<void>;
}

export async function startMockClamd(options: MockClamdOptions = {}): Promise<MockClamd> {
  const host = options.host ?? '127.0.0.1';
  const maxLen = options.streamMaxLength ?? 300 * 1024 * 1024;
  const version = options.version ?? 'ClamAV 1.5.4/27000/Mon Jan  1 00:00:00 2026 (PD test double)';
  const sockets = new Set<Socket>();
  let scanCount = 0;

  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => socket.destroy());

    // Command mode keeps a small buffer. Stream mode keeps only the 4-byte chunk header, the bytes left in the current
    // chunk, and a short tail for EICAR detection across chunk edges, so a stream costs O(n) time and O(1) memory.
    let cmdBuf = Buffer.alloc(0);
    let mode: 'command' | 'stream' = 'command';
    let terminator = 0; // 0 for the z form, 10 for the n form
    let streamed = 0;
    let remaining = 0; // bytes left in the current chunk
    const header = Buffer.alloc(4);
    let headerLen = 0;
    let tail = Buffer.alloc(0);
    let infected = false;

    const reply = (text: string): void => {
      socket.write(Buffer.concat([Buffer.from(text, 'latin1'), Buffer.from([terminator])]));
    };

    /** Reads commands from `input`. Returns what is left after an INSTREAM command, for stream mode. */
    function consumeCommand(input: Buffer): Buffer {
      cmdBuf = Buffer.concat([cmdBuf, input]);
      if (cmdBuf.length === 0) return cmdBuf;
      // The first byte is the form: `z` ends the command with NUL, `n` with a newline.
      const form = cmdBuf[0];
      if (form !== 0x7a && form !== 0x6e) {
        terminator = 0;
        reply('UNKNOWN COMMAND');
        socket.end();
        cmdBuf = Buffer.alloc(0);
        return cmdBuf;
      }
      terminator = form === 0x7a ? 0 : 10;
      const end = cmdBuf.indexOf(terminator);
      if (end < 0) {
        if (cmdBuf.length > 4096) socket.destroy();
        return Buffer.alloc(0);
      }
      const cmd = cmdBuf.subarray(1, end).toString('latin1').toUpperCase();
      const rest = cmdBuf.subarray(end + 1);
      cmdBuf = Buffer.alloc(0);
      if (cmd === 'PING' || cmd === 'VERSION') {
        reply(cmd === 'PING' ? 'PONG' : version);
        if (terminator === 10) socket.end();
      } else if (cmd === 'INSTREAM') {
        mode = 'stream';
        streamed = 0;
        remaining = 0;
        headerLen = 0;
        tail = Buffer.alloc(0);
        infected = false;
      } else {
        reply('UNKNOWN COMMAND');
        socket.end();
        return Buffer.alloc(0);
      }
      return rest;
    }

    /** Reads chunk data from `input`. Returns what is left after the zero-length terminator. */
    function consumeStream(input: Buffer): Buffer {
      let off = 0;
      while (off < input.length) {
        if (remaining === 0) {
          const take = Math.min(4 - headerLen, input.length - off);
          input.copy(header, headerLen, off, off + take);
          headerLen += take;
          off += take;
          if (headerLen < 4) break;
          headerLen = 0;
          const len = header.readUInt32BE(0);
          if (len === 0) {
            scanCount += 1;
            reply(infected ? `stream: ${EICAR_SIGNATURE} FOUND` : 'stream: OK');
            mode = 'command';
            if (terminator === 10) socket.end();
            return input.subarray(off);
          }
          // Like clamd: refuse at the header, before any of the chunk arrives.
          if (streamed + len > maxLen) {
            reply('INSTREAM size limit exceeded. ERROR');
            socket.end();
            mode = 'command';
            return Buffer.alloc(0);
          }
          remaining = len;
          continue;
        }
        const n = Math.min(remaining, input.length - off);
        const slice = input.subarray(off, off + n);
        off += n;
        remaining -= n;
        streamed += n;
        if (!infected) {
          const window = Buffer.concat([tail, slice]);
          if (window.includes(EICAR_BYTES)) infected = true;
          tail = window.subarray(Math.max(window.length - (EICAR_BYTES.length - 1), 0));
        }
      }
      return Buffer.alloc(0);
    }

    socket.on('data', (d: Buffer) => {
      let input = d;
      while (input.length > 0 && !socket.destroyed) {
        input = mode === 'command' ? consumeCommand(input) : consumeStream(input);
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, host, resolve);
  });
  return {
    port: (server.address() as AddressInfo).port,
    host,
    scans: () => scanCount,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}

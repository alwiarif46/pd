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

    let buf = Buffer.alloc(0);
    let mode: 'command' | 'stream' = 'command';
    let terminator = 0; // 0 for the z form, 10 for the n form
    let streamed = 0;
    let tail = Buffer.alloc(0); // last bytes seen, to find EICAR across chunk edges
    let infected = false;
    let tooLong = false;

    const reply = (text: string): void => {
      socket.write(Buffer.concat([Buffer.from(text, 'latin1'), Buffer.from([terminator])]));
    };

    function parse(): void {
      for (;;) {
        if (mode === 'command') {
          if (buf.length === 0) return;
          // The first byte is the form: `z` ends the command with NUL, `n` with a newline.
          const form = buf[0];
          if (form !== 0x7a && form !== 0x6e) {
            terminator = 0;
            reply('UNKNOWN COMMAND');
            return void socket.end();
          }
          terminator = form === 0x7a ? 0 : 10;
          const end = buf.indexOf(terminator);
          if (end < 0) {
            if (buf.length > 4096) socket.destroy();
            return;
          }
          const cmd = buf.subarray(1, end).toString('latin1').toUpperCase();
          buf = buf.subarray(end + 1);
          if (cmd === 'PING') {
            reply('PONG');
            if (terminator === 10) return void socket.end();
          } else if (cmd === 'VERSION') {
            reply(version);
            if (terminator === 10) return void socket.end();
          } else if (cmd === 'INSTREAM') {
            mode = 'stream';
            streamed = 0;
            tail = Buffer.alloc(0);
            infected = false;
            tooLong = false;
          } else {
            reply('UNKNOWN COMMAND');
            return void socket.end();
          }
          continue;
        }
        // Stream mode: [4-byte big-endian length][data] chunks, ended by a zero length.
        if (buf.length < 4) return;
        const len = buf.readUInt32BE(0);
        if (len === 0) {
          buf = buf.subarray(4);
          scanCount += 1;
          if (tooLong) reply('INSTREAM size limit exceeded. ERROR');
          else reply(infected ? `stream: ${EICAR_SIGNATURE} FOUND` : 'stream: OK');
          mode = 'command';
          if (terminator === 10) return void socket.end();
          continue;
        }
        if (buf.length < 4 + len) return;
        const chunk = buf.subarray(4, 4 + len);
        buf = buf.subarray(4 + len);
        streamed += len;
        if (streamed > maxLen) tooLong = true;
        if (!infected && !tooLong) {
          const window = Buffer.concat([tail, chunk]);
          if (window.includes(EICAR_BYTES)) infected = true;
          tail = window.subarray(Math.max(window.length - (EICAR_BYTES.length - 1), 0));
        }
      }
    }

    socket.on('data', (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      parse();
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

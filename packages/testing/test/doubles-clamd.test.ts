import { connect, type Socket } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EICAR, startMockClamd, type MockClamd } from '../src/index';

let clamd: MockClamd;
beforeAll(async () => {
  clamd = await startMockClamd({ streamMaxLength: 1024 * 1024 });
});
afterAll(async () => {
  await clamd.close();
});

function open(): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const s = connect({ host: clamd.host, port: clamd.port }, () => resolve(s));
    s.once('error', reject);
  });
}

/** Reads until the terminator byte (NUL for the z form, newline for n), as a clamd client does. */
function readReply(s: Socket, terminator: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    s.on('data', (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      const i = buf.indexOf(terminator);
      if (i >= 0) resolve(buf.subarray(0, i).toString('latin1'));
    });
    s.once('error', reject);
    s.once('close', () => reject(new Error(`closed before a reply (got ${JSON.stringify(buf.toString())})`)));
  });
}

function chunk(data: Buffer): Buffer {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length);
  return Buffer.concat([head, data]);
}
const END = Buffer.alloc(4);

async function scan(parts: Buffer[]): Promise<string> {
  const s = await open();
  try {
    s.write(Buffer.from('zINSTREAM\0'));
    for (const p of parts) s.write(chunk(p));
    s.write(END);
    return await readReply(s, 0);
  } finally {
    s.destroy();
  }
}

describe('clamd double', () => {
  it('answers zPING with PONG', async () => {
    const s = await open();
    s.write('zPING\0');
    expect(await readReply(s, 0)).toBe('PONG');
    s.destroy();
  });

  it('answers nPING with a newline-terminated PONG and closes', async () => {
    const s = await open();
    s.write('nPING\n');
    expect(await readReply(s, 10)).toBe('PONG');
    s.destroy();
  });

  it('answers zVERSION with a ClamAV version string', async () => {
    const s = await open();
    s.write('zVERSION\0');
    expect(await readReply(s, 0)).toMatch(/^ClamAV \d+\.\d+\.\d+/);
    s.destroy();
  });

  it('keeps one connection for several commands', async () => {
    const s = await open();
    s.write('zPING\0');
    expect(await readReply(s, 0)).toBe('PONG');
    s.removeAllListeners('data');
    s.write('zVERSION\0');
    expect(await readReply(s, 0)).toMatch(/^ClamAV/);
    s.destroy();
  });

  it('INSTREAM of clean data replies stream: OK', async () => {
    expect(await scan([Buffer.from('just a proposal draft')])).toBe('stream: OK');
  });

  it('INSTREAM of an empty stream replies stream: OK', async () => {
    expect(await scan([])).toBe('stream: OK');
  });

  it('INSTREAM that contains EICAR replies Eicar-Test-Signature FOUND', async () => {
    expect(await scan([Buffer.from(`hello ${EICAR} bye`, 'latin1')])).toBe('stream: Eicar-Test-Signature FOUND');
  });

  it('finds EICAR split across chunks', async () => {
    const e = Buffer.from(EICAR, 'latin1');
    expect(await scan([Buffer.from('xx'), e.subarray(0, 10), e.subarray(10, 30), e.subarray(30)])).toBe('stream: Eicar-Test-Signature FOUND');
  });

  it('a clean scan after an infected one on the same connection is clean', async () => {
    const s = await open();
    s.write('zINSTREAM\0');
    s.write(chunk(Buffer.from(EICAR, 'latin1')));
    s.write(END);
    expect(await readReply(s, 0)).toBe('stream: Eicar-Test-Signature FOUND');
    s.removeAllListeners('data');
    s.write('zINSTREAM\0');
    s.write(chunk(Buffer.from('clean')));
    s.write(END);
    expect(await readReply(s, 0)).toBe('stream: OK');
    s.destroy();
  });

  it('reports a size error over the stream limit, and counts scans', async () => {
    const before = clamd.scans();
    expect(await scan([Buffer.alloc(600 * 1024), Buffer.alloc(600 * 1024)])).toBe('INSTREAM size limit exceeded. ERROR');
    expect(clamd.scans()).toBe(before + 1);
  });

  it('rejects an unknown command', async () => {
    const s = await open();
    s.write('zFROBNICATE\0');
    expect(await readReply(s, 0)).toBe('UNKNOWN COMMAND');
    s.destroy();
  });
});

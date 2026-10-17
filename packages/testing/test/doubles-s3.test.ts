import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startMockS3, type MockS3 } from '../src/index';

let s3: MockS3;
const AUTH = { authorization: 'AWS4-HMAC-SHA256 Credential=dev/20260101/us-east-1/s3/aws4_request, SignedHeaders=host, Signature=00' };

beforeAll(async () => {
  s3 = await startMockS3();
});
afterAll(async () => {
  await s3.close();
});

const put = (path: string, body?: string, extra: Record<string, string> = {}): Promise<Response> =>
  fetch(`${s3.url}${path}`, { method: 'PUT', headers: { ...AUTH, ...extra }, ...(body !== undefined ? { body } : {}) });

describe('in-memory S3', () => {
  it('refuses a request with no Authorization header', async () => {
    const res = await fetch(`${s3.url}/b1`, { method: 'PUT' });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('AccessDenied');
  });

  it('creates a bucket, puts, gets, heads and deletes an object (path-style)', async () => {
    expect((await put('/docs')).status).toBe(200);
    expect((await fetch(`${s3.url}/docs`, { method: 'HEAD', headers: AUTH })).status).toBe(200);

    const p = await put('/docs/a/b.txt', 'hello world', { 'content-type': 'text/plain' });
    expect(p.status).toBe(200);
    expect(p.headers.get('etag')).toBe('"5eb63bbbe01eeed093cb22bb8f5acdc3"'); // md5 of "hello world"

    const g = await fetch(`${s3.url}/docs/a/b.txt`, { headers: AUTH });
    expect(g.status).toBe(200);
    expect(g.headers.get('content-type')).toBe('text/plain');
    expect(await g.text()).toBe('hello world');

    const h = await fetch(`${s3.url}/docs/a/b.txt`, { method: 'HEAD', headers: AUTH });
    expect(h.status).toBe(200);
    expect(h.headers.get('content-length')).toBe('11');
    expect(h.headers.get('etag')).toBe('"5eb63bbbe01eeed093cb22bb8f5acdc3"');

    const r = await fetch(`${s3.url}/docs/a/b.txt`, { headers: { ...AUTH, range: 'bytes=0-4' } });
    expect(r.status).toBe(206);
    expect(await r.text()).toBe('hello');

    expect((await fetch(`${s3.url}/docs/a/b.txt`, { method: 'DELETE', headers: AUTH })).status).toBe(204);
    const gone = await fetch(`${s3.url}/docs/a/b.txt`, { headers: AUTH });
    expect(gone.status).toBe(404);
    expect(await gone.text()).toContain('NoSuchKey');
    expect((await fetch(`${s3.url}/docs/a/b.txt`, { method: 'HEAD', headers: AUTH })).status).toBe(404);
  });

  it('reports NoSuchBucket for a bucket that was never created', async () => {
    const res = await fetch(`${s3.url}/nobucket/x`, { headers: AUTH });
    expect(res.status).toBe(404);
    expect(await res.text()).toContain('NoSuchBucket');
  });

  it('keeps binary bytes intact', async () => {
    await put('/bin');
    const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
    await fetch(`${s3.url}/bin/all.bin`, { method: 'PUT', headers: AUTH, body: bytes });
    const back = new Uint8Array(await (await fetch(`${s3.url}/bin/all.bin`, { headers: AUTH })).arrayBuffer());
    expect(Array.from(back)).toEqual(Array.from(bytes));
  });

  it('lists with ListObjectsV2: prefix, delimiter and paging', async () => {
    await put('/list');
    for (const k of ['t1/a.pdf', 't1/b.pdf', 't1/sub/c.pdf', 't2/a.pdf', 'root.txt']) await put(`/list/${k}`, k);

    const all = await (await fetch(`${s3.url}/list?list-type=2`, { headers: AUTH })).text();
    expect([...all.matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1])).toEqual(['root.txt', 't1/a.pdf', 't1/b.pdf', 't1/sub/c.pdf', 't2/a.pdf']);
    expect(all).toContain('<KeyCount>5</KeyCount>');

    const t1 = await (await fetch(`${s3.url}/list?list-type=2&prefix=t1/`, { headers: AUTH })).text();
    expect([...t1.matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1])).toEqual(['t1/a.pdf', 't1/b.pdf', 't1/sub/c.pdf']);

    const delim = await (await fetch(`${s3.url}/list?list-type=2&prefix=t1/&delimiter=/`, { headers: AUTH })).text();
    expect([...delim.matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1])).toEqual(['t1/a.pdf', 't1/b.pdf']);
    expect([...delim.matchAll(/<Prefix>([^<]+)<\/Prefix>/g)].map((m) => m[1])).toContain('t1/sub/');

    const page1 = await (await fetch(`${s3.url}/list?list-type=2&max-keys=2`, { headers: AUTH })).text();
    expect(page1).toContain('<IsTruncated>true</IsTruncated>');
    const token = /<NextContinuationToken>([^<]+)</.exec(page1)?.[1] as string;
    const page2 = await (await fetch(`${s3.url}/list?list-type=2&max-keys=10&continuation-token=${encodeURIComponent(token)}`, { headers: AUTH })).text();
    expect([...page2.matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1])).toEqual(['t1/b.pdf', 't1/sub/c.pdf', 't2/a.pdf']);
    expect(page2).toContain('<IsTruncated>false</IsTruncated>');
  });

  it('exposes stored objects to assertions', async () => {
    await put('/seen');
    await put('/seen/k', 'v');
    expect(s3.objects('seen').get('k')?.body.toString()).toBe('v');
  });
});

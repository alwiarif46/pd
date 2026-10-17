// In-memory S3 subset over HTTP, path-style. Stands in for the S3 store (SeaweedFS in Compose) when E2E_STACK=native.
// Supports CreateBucket, HeadBucket, PutObject, GetObject (with a simple Range), HeadObject, DeleteObject and
// ListObjectsV2 (prefix, delimiter, max-keys, continuation-token). A request needs an Authorization header; the
// signature is not checked. For tests and local runs only: never import it from production code.
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface MockS3Options {
  port?: number;
  host?: string;
  /** Buckets that exist at start. */
  buckets?: string[];
}

export interface MockS3 {
  url: string;
  port: number;
  /** Direct access for assertions, without going through HTTP. */
  objects(bucket: string): Map<string, StoredObject>;
  close(): Promise<void>;
}

export interface StoredObject {
  body: Buffer;
  contentType: string;
  etag: string;
  lastModified: Date;
}

const xmlEscape = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function xmlError(res: ServerResponse, status: number, code: string, message: string, head = false): void {
  const body = `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${xmlEscape(message)}</Message></Error>`;
  res.writeHead(status, { 'content-type': 'application/xml', 'content-length': head ? 0 : Buffer.byteLength(body) });
  res.end(head ? undefined : body);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Clients that stream with `aws-chunked` framing send the payload in chunks; decode it to the plain bytes. */
function decodeAwsChunked(raw: Buffer): Buffer {
  const parts: Buffer[] = [];
  let pos = 0;
  while (pos < raw.length) {
    const lineEnd = raw.indexOf('\r\n', pos);
    if (lineEnd < 0) break;
    const size = parseInt(raw.subarray(pos, lineEnd).toString('ascii').split(';')[0] ?? '', 16);
    if (!Number.isFinite(size) || size === 0) break;
    parts.push(raw.subarray(lineEnd + 2, lineEnd + 2 + size));
    pos = lineEnd + 2 + size + 2;
  }
  return Buffer.concat(parts);
}

export async function startMockS3(options: MockS3Options = {}): Promise<MockS3> {
  const host = options.host ?? '127.0.0.1';
  const store = new Map<string, Map<string, StoredObject>>();
  for (const b of options.buckets ?? []) store.set(b, new Map());

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? 'GET';
    const head = method === 'HEAD';
    if (!req.headers.authorization && !new URL(req.url ?? '/', 'http://x').searchParams.has('X-Amz-Signature')) {
      return xmlError(res, 403, 'AccessDenied', 'Access Denied: an Authorization header is required', head);
    }
    const url = new URL(req.url ?? '/', 'http://x');
    const segments = url.pathname.split('/').filter((s) => s.length > 0);
    const bucket = segments[0] ? decodeURIComponent(segments[0]) : '';
    const key = segments.length > 1 ? segments.slice(1).map(decodeURIComponent).join('/') : '';

    if (!bucket) {
      if (method !== 'GET') return xmlError(res, 405, 'MethodNotAllowed', 'method not allowed', head);
      const names = [...store.keys()].sort();
      const xml =
        '<?xml version="1.0" encoding="UTF-8"?><ListAllMyBucketsResult><Buckets>' +
        names.map((n) => `<Bucket><Name>${xmlEscape(n)}</Name></Bucket>`).join('') +
        '</Buckets></ListAllMyBucketsResult>';
      res.writeHead(200, { 'content-type': 'application/xml' });
      return void res.end(xml);
    }

    // Bucket level
    if (!key) {
      if (method === 'PUT') {
        await readBody(req);
        if (!store.has(bucket)) store.set(bucket, new Map());
        res.writeHead(200, { location: `/${bucket}`, 'content-length': 0 });
        return void res.end();
      }
      const objs = store.get(bucket);
      if (!objs) return xmlError(res, 404, 'NoSuchBucket', `The bucket ${bucket} does not exist`, head);
      if (method === 'HEAD') {
        res.writeHead(200, { 'content-length': 0 });
        return void res.end();
      }
      if (method === 'DELETE') {
        if (objs.size > 0) return xmlError(res, 409, 'BucketNotEmpty', 'The bucket you tried to delete is not empty');
        store.delete(bucket);
        res.writeHead(204);
        return void res.end();
      }
      if (method === 'GET') {
        const q = url.searchParams;
        const prefix = q.get('prefix') ?? '';
        const delimiter = q.get('delimiter') ?? '';
        const max = Math.min(Math.max(parseInt(q.get('max-keys') ?? '1000', 10) || 1000, 1), 1000);
        const after = q.get('continuation-token') ?? q.get('start-after') ?? '';
        const keys = [...objs.keys()].filter((k) => k.startsWith(prefix) && k > after).sort();
        const contents: string[] = [];
        const prefixes = new Set<string>();
        let count = 0;
        let lastKey = '';
        let truncated = false;
        for (const k of keys) {
          const rest = k.slice(prefix.length);
          const cut = delimiter ? rest.indexOf(delimiter) : -1;
          const entryKey = cut >= 0 ? prefix + rest.slice(0, cut + delimiter.length) : k;
          if (cut >= 0 && prefixes.has(entryKey)) {
            lastKey = k;
            continue;
          }
          if (count >= max) {
            truncated = true;
            break;
          }
          count += 1;
          lastKey = k;
          if (cut >= 0) prefixes.add(entryKey);
          else {
            const o = objs.get(k) as StoredObject;
            contents.push(
              `<Contents><Key>${xmlEscape(k)}</Key><LastModified>${o.lastModified.toISOString()}</LastModified>` +
                `<ETag>"${o.etag}"</ETag><Size>${o.body.length}</Size><StorageClass>STANDARD</StorageClass></Contents>`,
            );
          }
        }
        const xml =
          '<?xml version="1.0" encoding="UTF-8"?><ListBucketResult>' +
          `<Name>${xmlEscape(bucket)}</Name><Prefix>${xmlEscape(prefix)}</Prefix>` +
          (delimiter ? `<Delimiter>${xmlEscape(delimiter)}</Delimiter>` : '') +
          `<KeyCount>${count}</KeyCount><MaxKeys>${max}</MaxKeys><IsTruncated>${truncated}</IsTruncated>` +
          (truncated ? `<NextContinuationToken>${xmlEscape(lastKey)}</NextContinuationToken>` : '') +
          contents.join('') +
          [...prefixes].map((p) => `<CommonPrefixes><Prefix>${xmlEscape(p)}</Prefix></CommonPrefixes>`).join('') +
          '</ListBucketResult>';
        res.writeHead(200, { 'content-type': 'application/xml' });
        return void res.end(xml);
      }
      return xmlError(res, 405, 'MethodNotAllowed', 'method not allowed', head);
    }

    // Object level
    const objs = store.get(bucket);
    if (!objs) {
      if (method === 'PUT') await readBody(req);
      return xmlError(res, 404, 'NoSuchBucket', `The bucket ${bucket} does not exist`, head);
    }

    if (method === 'PUT') {
      let body = await readBody(req);
      if (String(req.headers['content-encoding'] ?? '').includes('aws-chunked') || String(req.headers['x-amz-content-sha256'] ?? '').startsWith('STREAMING-')) {
        body = decodeAwsChunked(body);
      }
      const etag = createHash('md5').update(body).digest('hex');
      objs.set(key, {
        body,
        contentType: String(req.headers['content-type'] ?? 'application/octet-stream'),
        etag,
        lastModified: new Date(),
      });
      res.writeHead(200, { etag: `"${etag}"`, 'content-length': 0 });
      return void res.end();
    }

    if (method === 'DELETE') {
      objs.delete(key); // deleting a missing key is a success, as in S3
      res.writeHead(204);
      return void res.end();
    }

    if (method === 'GET' || method === 'HEAD') {
      const o = objs.get(key);
      if (!o) return xmlError(res, 404, 'NoSuchKey', 'The specified key does not exist.', head);
      const headers: Record<string, string | number> = {
        'content-type': o.contentType,
        etag: `"${o.etag}"`,
        'last-modified': o.lastModified.toUTCString(),
        'accept-ranges': 'bytes',
      };
      let body = o.body;
      let status = 200;
      const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''));
      if (range && (range[1] || range[2])) {
        const total = o.body.length;
        const start = range[1] ? parseInt(range[1], 10) : Math.max(total - parseInt(range[2] as string, 10), 0);
        const end = range[1] && range[2] ? Math.min(parseInt(range[2], 10), total - 1) : total - 1;
        if (start >= total || start > end) {
          res.writeHead(416, { 'content-range': `bytes */${total}` });
          return void res.end();
        }
        body = o.body.subarray(start, end + 1);
        headers['content-range'] = `bytes ${start}-${end}/${total}`;
        status = 206;
      }
      headers['content-length'] = body.length;
      res.writeHead(status, headers);
      return void res.end(head ? undefined : body);
    }

    xmlError(res, 405, 'MethodNotAllowed', 'method not allowed', head);
  }

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      if (!res.headersSent) xmlError(res, 500, 'InternalError', (err as Error).message);
      else res.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, host, resolve);
  });
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://${host}:${port}`,
    port,
    objects: (bucket) => {
      let m = store.get(bucket);
      if (!m) {
        m = new Map();
        store.set(bucket, m);
      }
      return m;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

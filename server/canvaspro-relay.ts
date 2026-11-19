import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import type { ReadableStream } from 'node:stream/web';
import { pipeline } from 'node:stream/promises';
import type { Plugin, ViteDevServer } from 'vite';
import { CANVASPRO_ORIGIN } from '../src/canvaspro-models';
import { TRANSFER_PATH, TRANSFER_CHUNK_BYTES, TRANSFER_MAX_BYTES } from '../src/canvaspro-transfer';

const apiPrefix = '/__canvaspro';
const submitPaths = new Set([
  '/v1/images/edits',
  '/kr/v1/images/edits',
  '/kr/gpt/v1/images/edits',
  '/hc/v1/images/edits/upload',
  '/kr/gemini/v1/images/generations',
  '/aistars/v1/images/edits',
  '/v1/media/batches',
  '/v1/media/uploads',
]);
const queryPath =
  /^\/(?:kr\/(?:gpt\/|gemini\/)?v1\/images\/tasks|hc\/v1\/images\/tasks|aistars\/v1\/tasks|v1\/media\/(?:batches|uploads))\/[A-Za-z0-9_-]+$/;
const artifactPath = /^(\/v1\/tasks\/[A-Za-z0-9_-]+\/artifacts)\/(image-\d+)\/content$/;
const artifactListPath = /^\/v1\/tasks\/[A-Za-z0-9_-]+\/artifacts$/;
const transferIdPattern = /^[a-f0-9-]{36}$/;
const transferLifetime = 300_000;
const relayHeaders = [
  'authorization',
  'content-type',
  'x-temporary-media-batch',
  'x-temporary-media-index',
];
const responseHeaders = [
  'content-type',
  'retry-after',
  'x-request-id',
  'x-oneapi-request-id',
  'cf-ray',
];

class RelayError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function respond(res: ServerResponse, status: number, message?: string) {
  res.statusCode = status;
  res.setHeader('Cache-Control', 'no-store');
  if (!message) return res.end();
  res.setHeader('Content-Type', 'application/json');
  return res.end(JSON.stringify({ error: { message } }));
}

async function readBytes(req: IncomingMessage, limit: number): Promise<Buffer<ArrayBuffer>> {
  const length = req.headers['content-length'];
  if (length && Number(length) > limit) throw new RelayError(413, 'Request body is too large');
  const parts: Buffer[] = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > limit) throw new RelayError(413, 'Request body is too large');
    parts.push(chunk);
  }
  return Buffer.concat(parts);
}

interface Transfer {
  parts: Buffer[];
  length: number;
  received: number;
  timer: ReturnType<typeof setTimeout>;
}

export function canvasProRelay(target = CANVASPRO_ORIGIN): Plugin {
  const transfers = new Map<string, Transfer>();
  let reservedBytes = 0;

  const removeTransfer = (id: string) => {
    const transfer = transfers.get(id);
    if (!transfer) return;
    clearTimeout(transfer.timer);
    reservedBytes -= transfer.length;
    transfers.delete(id);
  };

  async function storeChunk(req: IncomingMessage, res: ServerResponse, id: string) {
    const offset = Number(req.headers['x-transfer-offset']);
    const length = Number(req.headers['x-transfer-length']);
    if (
      req.method !== 'PUT' ||
      !transferIdPattern.test(id) ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(length) ||
      length <= 0 ||
      length > TRANSFER_MAX_BYTES
    )
      throw new RelayError(400, 'Invalid transfer metadata');

    const chunk = await readBytes(req, TRANSFER_CHUNK_BYTES);
    let transfer = transfers.get(id);
    if (
      !chunk.length ||
      offset + chunk.length > length ||
      (transfer ? offset !== transfer.received || length !== transfer.length : offset !== 0)
    )
      throw new RelayError(409, 'Image transfer is out of sequence');
    if (!transfer) {
      if (transfers.size >= 16 || reservedBytes + length > TRANSFER_MAX_BYTES * 2)
        throw new RelayError(429, 'Local image transfers are busy');
      const timer = setTimeout(() => removeTransfer(id), transferLifetime).unref();
      transfer = { parts: [], length, received: 0, timer };
      reservedBytes += length;
      transfers.set(id, transfer);
    }
    transfer.parts.push(chunk);
    transfer.received += chunk.length;
    transfer.timer.refresh();
    respond(res, 204);
  }

  async function forward(req: IncomingMessage, res: ServerResponse, path: string) {
    const backupRequested = req.method === 'GET' && path.endsWith('?source=backup');
    if (backupRequested) path = path.slice(0, -'?source=backup'.length);
    const artifact = artifactPath.exec(path);
    const posting = req.method === 'POST';
    if (
      !(posting
        ? submitPaths.has(path)
        : req.method === 'GET' &&
          (queryPath.test(path) || artifact || artifactListPath.test(path))) ||
      (backupRequested && !artifact) ||
      !req.headers.authorization?.startsWith('Bearer ')
    )
      throw new RelayError(404, 'Unknown CanvasPro route');

    const headers = new Headers();
    for (const name of relayHeaders) {
      const value = req.headers[name];
      if (typeof value === 'string') headers.set(name, value);
    }
    let body: Buffer<ArrayBuffer> | undefined;
    const id = req.headers['x-canvaspro-transfer'];
    if (posting && typeof id === 'string') {
      const transfer = transfers.get(id);
      if (!transfer || transfer.received !== transfer.length)
        throw new RelayError(409, 'Local image transfer is incomplete');
      if ((await readBytes(req, TRANSFER_CHUNK_BYTES)).length)
        throw new RelayError(400, 'Staged request must have an empty body');
      if (transfers.get(id) !== transfer)
        throw new RelayError(409, 'Local image transfer has already been used');
      body = Buffer.concat(transfer.parts, transfer.length);
      removeTransfer(id);
    } else if (posting) {
      body = await readBytes(req, TRANSFER_CHUNK_BYTES);
    }

    const operation = `${req.method} ${path}`;
    const started = Date.now();
    const disconnected = new AbortController();
    res.once('close', () => {
      if (!res.writableFinished) disconnected.abort();
    });
    if (res.destroyed) return;
    const signal = AbortSignal.any([disconnected.signal, AbortSignal.timeout(620_000)]);
    try {
      if (posting) console.info(`[CanvasPro] Forwarding ${operation} (${body?.length ?? 0} bytes)`);
      let upstream: Response | undefined;
      if (backupRequested && artifact) {
        try {
          const backupSignal = AbortSignal.any([signal, AbortSignal.timeout(25_000)]);
          const metadata = await fetch(target + artifact[1], {
            headers,
            signal: backupSignal,
            redirect: 'error',
          });
          if (metadata.ok) {
            const data = (await metadata.json()) as {
              artifacts?: {
                key?: string;
                backup?: { state?: string };
                backup_download?: { url?: string };
              }[];
            };
            const image = data.artifacts?.find(
              (item) => item.key === artifact[2] && item.backup?.state === 'ready',
            );
            if (image?.backup_download?.url) {
              const signed = new URL(image.backup_download.url);
              if (
                signed.protocol === 'https:' &&
                !signed.username &&
                !signed.password &&
                !signed.port &&
                /^[a-f0-9]{32}\.r2\.cloudflarestorage\.com$/.test(signed.hostname)
              ) {
                const backup = await fetch(signed, { signal, redirect: 'error' });
                if (backup.ok) {
                  upstream = backup;
                  console.info(`[CanvasPro] Reading result backup ${path}`);
                } else await backup.body?.cancel();
              }
            }
          } else await metadata.body?.cancel();
        } catch {
          // Use the same task's protected download if the optional backup cannot be opened.
        }
      }
      upstream ??= await fetch(target + path, {
        method: req.method,
        headers,
        body,
        signal,
        redirect: 'error',
      });
      if (posting || !upstream.ok) {
        const id =
          upstream.headers.get('x-request-id') || upstream.headers.get('x-oneapi-request-id');
        const trace = id && /^[A-Za-z0-9_-]{1,96}$/.test(id) ? ` request=${id}` : '';
        console.info(
          `[CanvasPro] HTTP ${upstream.status} ${operation} (${Date.now() - started} ms)${trace}`,
        );
      }
      res.statusCode = upstream.status;
      res.setHeader('Cache-Control', 'no-store');
      for (const name of responseHeaders) {
        const value = upstream.headers.get(name);
        if (value) res.setHeader(name, value);
      }
      const length = upstream.headers.get('content-length');
      if (artifact && length && !upstream.headers.has('content-encoding'))
        res.setHeader('Content-Length', length);
      if (!upstream.body) res.end();
      else await pipeline(Readable.fromWeb(upstream.body as ReadableStream), res, { signal });
    } catch {
      if (res.destroyed || disconnected.signal.aborted) return;
      console.warn(`[CanvasPro] Connection ended during ${operation} (${Date.now() - started} ms)`);
      if (res.headersSent) res.destroy();
      else
        throw new RelayError(
          signal.aborted ? 504 : 502,
          'CanvasPro connection did not return a response',
        );
    }
  }

  function configure(server: Pick<ViteDevServer, 'middlewares'>) {
    server.middlewares.use((req, res, next) => {
      const url = req.url ?? '';
      const transferring = url.startsWith(TRANSFER_PATH);
      if (!transferring && !url.startsWith(apiPrefix + '/')) return next();
      if (
        (req.headers.origin && req.headers.origin !== 'http://' + req.headers.host) ||
        (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin')
      )
        return respond(res, 404, 'Unknown CanvasPro route');
      const operation = transferring
        ? storeChunk(req, res, url.slice(TRANSFER_PATH.length))
        : forward(req, res, url.slice(apiPrefix.length));
      void operation.catch((error: unknown) => {
        if (res.destroyed || res.headersSent) return;
        if (error instanceof RelayError) respond(res, error.status, error.message);
        else respond(res, 502, 'CanvasPro relay failed');
      });
    });
  }

  return { name: 'canvaspro-relay', configureServer: configure, configurePreviewServer: configure };
}

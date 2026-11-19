import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import sharp from 'sharp';
import { createServer } from 'vite';

const vite = await createServer({
  server: { middlewareMode: true, hmr: false, ws: false },
  optimizeDeps: { noDiscovery: true, include: [] },
  appType: 'custom',
});
const { canvasProRelay } = await vite.ssrLoadModule('/server/canvaspro-relay.ts');
const { TRANSFER_PATH, TRANSFER_CHUNK_BYTES } = await vite.ssrLoadModule(
  '/src/canvaspro-transfer.ts',
);
const api = await vite.ssrLoadModule('/src/generation.ts');
after(() => vite.close());

function localRelay(upstream) {
  return createServer({
    configFile: false,
    plugins: [canvasProRelay(`http://127.0.0.1:${upstream.address().port}`)],
    server: { host: '127.0.0.1', port: 0, hmr: false, ws: false },
    optimizeDeps: { noDiscovery: true, include: [] },
    appType: 'custom',
  });
}

test('local proxy preserves multipart bytes and auth, excludes cookies, and rejects foreign origins', async () => {
  const calls = [];
  const upstream = createHttpServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    calls.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks) });
    res.writeHead(401, { 'Content-Type': 'application/json', 'Set-Cookie': 'upstream=secret' });
    res.end(JSON.stringify({ error: { message: 'invalid test credential' } }));
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const server = await localRelay(upstream);
  try {
    await server.listen();
    const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
    const endpoint = `${origin}/__canvaspro/v1/images/edits`;
    const form = new FormData();
    form.set('model', 'gpt-image-2');
    form.append('image[]', new Blob(['pose-original']), 'pose.png');
    form.append('image[]', new Blob(['outfit-original']), 'outfit.png');
    const request = new Request(endpoint, { method: 'POST', body: form });
    const body = Buffer.from(await request.arrayBuffer());
    const response = await fetch(endpoint, {
      method: 'POST',
      body,
      headers: {
        Origin: origin,
        Authorization: 'Bearer local-test-only',
        Cookie: 'local-session=private',
        'Content-Type': request.headers.get('Content-Type'),
      },
    });
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error.message, 'invalid test credential');
    assert.equal(response.headers.get('set-cookie'), null);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, '/v1/images/edits');
    assert.equal(calls[0].headers.authorization, 'Bearer local-test-only');
    assert.equal(calls[0].headers.cookie, undefined);
    assert.deepEqual(calls[0].body, body);
    assert.equal(
      (await fetch(endpoint, { method: 'POST', headers: { Origin: 'https://other.example' } }))
        .status,
      404,
    );
    assert.equal((await fetch(endpoint)).status, 404);
    assert.equal(calls.length, 1);
  } finally {
    await server.close();
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test('a multi-megabyte reference reaches the provider intact before receiving its async receipt', async () => {
  const original = await sharp(randomBytes(900 * 850 * 3), {
    raw: { width: 900, height: 850, channels: 3 },
  })
    .png()
    .toBuffer();
  assert.ok(original.byteLength > 2 * 1024 * 1024);
  const calls = [];
  const upstream = createHttpServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    calls.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks) });
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify(
        req.method === 'POST'
          ? { task_id: 'task_complete_body', status: 'queued' }
          : { status: 'succeeded', data: [{ url: 'https://results.example/result.png' }] },
      ),
    );
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const server = await localRelay(upstream);
  try {
    await server.listen();
    const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
    const reference = {
      kind: 'character',
      file: new File([original], 'reference.png', { type: 'image/png' }),
      variant: { id: 'character' },
    };
    const progress = [];
    const parts = [];
    const result = await api.generateReferenceImage(
      { ...api.defaultImageConfig, model: 'gpt-image-2', apiKey: 'relay-test-only' },
      [reference],
      'Keep the reference identity',
      new AbortController().signal,
      async (url, options) => {
        if (url.startsWith(TRANSFER_PATH)) {
          assert.equal(options.method, 'PUT');
          assert.ok(options.body.size <= TRANSFER_CHUNK_BYTES);
          assert.equal(options.headers.Authorization, undefined);
          assert.equal(calls.length, 0);
          parts.push({ url, size: options.body.size });
        } else if (options.method === 'POST') {
          assert.equal(options.body, undefined);
          assert.ok(options.headers['X-CanvasPro-Transfer']);
        }
        return fetch(origin + url, options);
      },
      (update) => progress.push(update),
    );
    assert.ok(parts.length > 10);
    assert.deepEqual(
      calls.map((call) => call.url),
      ['/kr/v1/images/edits', '/kr/v1/images/tasks/task_complete_body'],
    );
    const request = calls[0];
    assert.equal(request.headers['content-length'], String(request.body.length));
    assert.equal(request.headers['x-canvaspro-transfer'], undefined);
    const form = await new Response(request.body, {
      headers: { 'Content-Type': request.headers['content-type'] },
    }).formData();
    assert.equal(form.get('model'), 'gpt-image-2');
    assert.deepEqual(Buffer.from(await form.get('image').arrayBuffer()), original);
    assert.deepEqual(progress.at(-1), { stage: 'accepted', taskId: 'task_complete_body' });
    assert.equal(result, 'https://results.example/result.png');

    const transfer = parts[0].url.slice(TRANSFER_PATH.length);
    const repeated = await fetch(origin + '/__canvaspro/kr/v1/images/edits', {
      method: 'POST',
      headers: { Authorization: 'Bearer relay-test-only', 'X-CanvasPro-Transfer': transfer },
    });
    assert.equal(repeated.status, 409);
    assert.equal(calls.length, 2);
  } finally {
    await server.close();
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test('reference network failures are distinguished from provider connection failures without retry', async () => {
  const reference = {
    kind: 'pose',
    title: { zh: 'test', en: 'test' },
    keywords: { zh: '', en: '' },
    variant: { id: 'pose', original: 'https://ai-pose-gallery.pages.dev/img/test.png' },
  };
  const config = { ...api.defaultImageConfig, apiKey: 'local-test-only' };
  let calls = 0;
  await assert.rejects(
    api.generateReferenceImage(
      config,
      [reference],
      'test',
      new AbortController().signal,
      async () => {
        calls++;
        throw new TypeError('Failed to fetch');
      },
    ),
    (error) => error.code === 'referenceFailed',
  );
  assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(
    api.generateReferenceImage(
      config,
      [reference],
      'test',
      new AbortController().signal,
      async (_url, options) => {
        calls++;
        if (options.method === 'POST') throw new TypeError('Failed to fetch');
        return new Response(new Blob(['test'], { type: 'image/png' }));
      },
    ),
    (error) => error.code === 'networkFailed',
  );
  assert.equal(calls, 2);
});

test('HTTP 403 is reported as access denied without retrying the paid request', async () => {
  const reference = {
    kind: 'pose',
    title: { zh: 'test', en: 'test' },
    keywords: { zh: '', en: '' },
    variant: { id: 'pose', original: 'https://ai-pose-gallery.pages.dev/img/test.png' },
  };
  let posts = 0;
  await assert.rejects(
    api.generateReferenceImage(
      { ...api.defaultImageConfig, apiKey: 'test-secret' },
      [reference],
      'test',
      new AbortController().signal,
      async (_url, options) => {
        if (options.method === 'POST') {
          posts++;
          return new Response('Forbidden', { status: 403 });
        }
        return new Response(new Blob(['test'], { type: 'image/png' }));
      },
    ),
    (error) =>
      error.code === 'accessDenied' && String(error.detail || error.message).includes('403'),
  );
  assert.equal(posts, 1);
});

test('HTML rejection retains bounded diagnostics and removes secrets', async () => {
  const { readImageResponse } = await vite.ssrLoadModule('/src/image-diagnostics.ts');
  globalThis.location = { origin: 'http://localhost:5199' };
  try {
    const result = await readImageResponse(
      new Response(
        '<html><h1>Access denied</h1>Bearer test-secret sk-private-value https://example.com/?token=private</html>',
        { status: 403, headers: { 'content-type': 'text/html', 'cf-ray': 'test-ray' } },
      ),
      'job-submit',
      'https://example.com/jobs?key=private',
      'test-secret',
    );
    const diagnostic = JSON.parse(result.diagnostic);
    assert.equal(diagnostic.stage, 'job-submit');
    assert.equal(diagnostic.status, 403);
    assert.equal(diagnostic.requestId, 'test-ray');
    assert.equal(diagnostic.endpoint, 'https://example.com/jobs');
    assert.match(diagnostic.response, /Access denied/);
    assert.equal(result.platformMessage, 'Access denied');
    assert.ok(!result.diagnostic.includes('private'));
    assert.ok(!result.diagnostic.includes('test-secret'));
  } finally {
    delete globalThis.location;
  }
});

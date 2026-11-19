import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';

const vite = await createServer({
  server: { middlewareMode: true, hmr: false, ws: false },
  optimizeDeps: { noDiscovery: true, include: [] },
  appType: 'custom',
});
const models = await vite.ssrLoadModule('/src/canvaspro-models.ts');
const api = await vite.ssrLoadModule('/src/generation.ts');
after(() => vite.close());
const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV1cAAAAASUVORK5CYII=';
const config = {
  ...api.defaultImageConfig,
  apiKey: 'test-only-key',
  rememberKey: false,
};
const references = ['pose', 'costume'].map((kind) => ({
  kind,
  title: { zh: kind, en: kind },
  keywords: { zh: kind, en: kind },
  variant: {
    id: kind,
    image: '',
    thumbnail: '',
    original: `https://ai-${kind}-gallery.pages.dev/img/${kind}.png`,
  },
}));

test('CanvasPro is the only configured gateway and has 45 distinct image models', () => {
  const ids = models.imageModelGroups.flatMap(([, group]) => group);
  assert.equal(new Set(ids).size, 45);
  assert.equal(api.defaultImageConfig.model, 'gpt-image-2.6-sunburst-W');
  assert.equal(api.imageConfigReady(api.defaultImageConfig), false);
  assert.equal(api.imageConfigReady(config), true);
  assert.equal(api.imageConfigReady({ ...config, model: 'open-image-v2' }), false);
  assert.equal(api.imageConfigReady({ ...config, model: 'T香蕉pro', size: '1:8 · 1K' }), false);
  assert.equal(
    api.imageConfigReady({ ...config, model: '即梦-65-seedream-5.5', size: '1:1 · 4K' }),
    false,
  );
});

test('CanvasPro keys are session-only by default, optionally remembered, and isolated from the old settings', () => {
  const storage = () => {
    const values = new Map();
    return {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
      removeItem: (key) => values.delete(key),
    };
  };
  globalThis.localStorage = storage();
  globalThis.sessionStorage = storage();
  try {
    localStorage.setItem(
      'opc-image-settings',
      JSON.stringify({
        version: 2,
        activeService: 'atomflow',
        services: { atomflow: { apiKey: 'legacy-key' } },
      }),
    );
    assert.equal(api.loadImageConfig().apiKey, '');
    api.saveImageConfig(config);
    assert.ok(!localStorage.getItem('opc-image-settings').includes(config.apiKey));
    assert.equal(api.loadImageConfig().apiKey, config.apiKey);
    sessionStorage.removeItem('opc-image-session-key-canvaspro');
    assert.equal(api.loadImageConfig().apiKey, '');
    api.saveImageConfig({ ...config, rememberKey: true });
    assert.equal(api.loadImageConfig().apiKey, config.apiKey);
    api.clearImageConfig();
    assert.deepEqual(api.loadImageConfig(), api.defaultImageConfig);
  } finally {
    delete globalThis.localStorage;
    delete globalThis.sessionStorage;
  }
});

test('image edit request attaches both original files and keeps auth off image sources', async () => {
  const calls = [];
  const result = await api.generateReferenceImage(
    config,
    references,
    'draw a character',
    new AbortController().signal,
    async (url, options) => {
      calls.push({ url, options });
      return calls.length <= 2
        ? new Response(Buffer.from(png, 'base64'), { headers: { 'Content-Type': 'image/png' } })
        : Response.json({ data: [{ b64_json: png }] });
    },
  );
  assert.equal(result, `data:image/png;base64,${png}`);
  assert.equal(calls.length, 3);
  assert.equal(calls[0].options.headers, undefined);
  assert.equal(calls[1].options.headers, undefined);
  const request = calls[2];
  assert.equal(request.url, '/__canvaspro/v1/images/edits');
  assert.equal(request.options.headers.Authorization, `Bearer ${config.apiKey}`);
  assert.equal(request.options.headers['Content-Type'], undefined);
  assert.equal(request.options.body.getAll('image[]').length, 2);
  assert.equal(request.options.body.get('model'), api.defaultImageConfig.model);
  assert.equal(request.options.body.get('quality'), null);
  assert.equal(request.options.body.get('output_format'), 'png');
  assert.equal(request.options.body.get('prompt'), 'draw a character');
  assert.equal(request.options.body.get('input_fidelity'), null);
});

test('SR requests use the synchronous path and omit unsupported quality parameters', async () => {
  const calls = [];
  const srConfig = { ...api.defaultImageConfig, apiKey: 'test-only-key', model: 'gpt-image-2-SR' };
  await api.generateReferenceImage(
    srConfig,
    references,
    'generate with an SR model',
    new AbortController().signal,
    async (url, options) => {
      calls.push({ url, options });
      return calls.length <= 2
        ? new Response(Buffer.from(png, 'base64'), { headers: { 'Content-Type': 'image/png' } })
        : Response.json({ data: [{ b64_json: png }] });
    },
  );
  const request = calls[2];
  assert.equal(request.url, '/__canvaspro/v1/images/edits');
  assert.equal(request.options.headers.Authorization, `Bearer ${srConfig.apiKey}`);
  assert.equal(request.options.body.get('model'), srConfig.model);
  assert.equal(request.options.body.get('quality'), null);
  assert.equal(request.options.body.get('size'), '1024x1536');
});

test('KR and HC submit their file formats once and query their own task endpoint', async () => {
  const lines = [
    ['gpt-image-2', '/kr/v1/images/edits', '/kr/v1/images/tasks/', 'image'],
    ['gpt-image-2.5-flare', '/kr/gpt/v1/images/edits', '/kr/gpt/v1/images/tasks/', 'image'],
    ['s-gpt-image-2', '/hc/v1/images/edits/upload', '/hc/v1/images/tasks/', 'image'],
  ];
  for (const [model, submit, query, fileField] of lines) {
    const calls = [];
    const progress = [];
    const image = await api.generateReferenceImage(
      { ...config, model },
      [references[0]],
      'Use the pose',
      new AbortController().signal,
      async (url, options) => {
        calls.push(url);
        if (url === references[0].variant.original) {
          return new Response(Buffer.from(png, 'base64'), {
            headers: { 'Content-Type': 'image/png' },
          });
        }
        if (url === '/__canvaspro' + submit) {
          assert.deepEqual(progress.at(-1), { stage: 'submitting' });
          assert.equal(options.method, 'POST');
          assert.equal(options.body.get(fileField).name, 'pose.png');
          assert.equal(options.body.get('model'), model);
          return Response.json({ task_id: 'task_img1', status: 'queued' });
        }
        assert.equal(url, '/__canvaspro' + query + 'task_img1');
        assert.deepEqual(progress.at(-1), { stage: 'accepted', taskId: 'task_img1' });
        assert.equal(options.method, undefined);
        return Response.json({
          status: 'succeeded',
          data: [{ url: 'https://results.example/image.png' }],
        });
      },
      (update) => progress.push(update),
    );
    assert.equal(image, 'https://results.example/image.png');
    assert.equal(calls.length, 3);
  }
});

test('an accepted task reports its actual failure instead of a submission error', async () => {
  let submissions = 0;
  await assert.rejects(
    api.generateReferenceImage(
      { ...config, model: 'gpt-image-2' },
      [references[0]],
      'Use the reference',
      new AbortController().signal,
      async (url, options) => {
        if (url === references[0].variant.original)
          return new Response(Buffer.from(png, 'base64'), {
            headers: { 'Content-Type': 'image/png' },
          });
        if (options.method === 'POST') {
          submissions++;
          return Response.json({ task_id: 'task_review' });
        }
        return Response.json({ status: 'failed', error: 'Content review rejected this task' });
      },
    ),
    (error) =>
      error.code === 'taskFailed' &&
      error.platformMessage === 'Content review rejected this task' &&
      /task_review\nContent review rejected/.test(error.message),
  );
  assert.equal(submissions, 1);
});

test('Gemini sends inline references and Jimeng recovers an interrupted download by querying the same task', async (t) => {
  t.after(() => {
    delete globalThis.FileReader;
  });
  globalThis.FileReader = class {
    async readAsDataURL(blob) {
      const encoded = Buffer.from(await blob.arrayBuffer()).toString('base64');
      this.result = 'data:' + blob.type + ';base64,' + encoded;
      this.onload();
    }
  };
  const image = () =>
    new Response(Buffer.from(png, 'base64'), { headers: { 'Content-Type': 'image/png' } });
  const calls = [];
  const signal = new AbortController().signal;
  const gemini = await api.generateReferenceImage(
    { ...config, model: 'T香蕉2.1', size: '3:4 · 2K' },
    references,
    'Combine these',
    signal,
    async (url, options) => {
      if (!url.startsWith('/__canvaspro')) return image();
      calls.push(url);
      if (options.method === 'POST') {
        assert.equal(url, '/__canvaspro/kr/gemini/v1/images/generations');
        const body = JSON.parse(options.body);
        assert.deepEqual(body.generationConfig.imageConfig, {
          aspectRatio: '3:4',
          imageSize: '2K',
        });
        assert.deepEqual(body.contents[0].parts, [
          { text: 'Combine these' },
          ...references.map(() => ({ inlineData: { mimeType: 'image/png', data: png } })),
        ]);
        return Response.json({ task_id: 'gemini_1' });
      }
      assert.equal(url, '/__canvaspro/kr/gemini/v1/images/tasks/gemini_1');
      return Response.json({ status: 'succeeded', data: [{ b64_json: png }] });
    },
  );
  assert.equal(gemini, 'data:image/png;base64,' + png);
  assert.equal(calls.length, 2);

  const urls = ['media_pose', 'media_costume'].map(
    (id) => 'https://api.canvasproai.com/v1/media/files/' + id + '?token=test',
  );
  const artifact = '/v1/tasks/jimeng_1/artifacts/image-0/content';
  const uploads = [];
  const progress = [];
  let edits = 0;
  let queries = 0;
  let downloads = 0;
  const jimeng = await api.generateReferenceImage(
    { ...config, model: '即梦-65-seedream-5-lite', size: '3:4 · 2K' },
    references,
    'Combine these',
    signal,
    async (url, options) => {
      if (!url.startsWith('/__canvaspro')) return image();
      assert.equal(options.headers.Authorization, 'Bearer ' + config.apiKey);
      switch (url.slice('/__canvaspro'.length)) {
        case '/v1/media/batches':
          assert.deepEqual(progress.at(-1), { stage: 'uploadingReferences' });
          assert.equal(JSON.parse(options.body).expected_count, 2);
          return Response.json({ id: 'batch_1' });
        case '/v1/media/uploads': {
          assert.equal(options.headers['X-Temporary-Media-Batch'], 'batch_1');
          const index = Number(options.headers['X-Temporary-Media-Index']);
          uploads.push(options.body.get('file').name);
          return Response.json({ id: index === 1 ? 'media_pose' : 'media_costume' });
        }
        case '/v1/media/uploads/media_pose':
        case '/v1/media/uploads/media_costume':
          return Response.json({ state: 'ready' });
        case '/v1/media/batches/batch_1':
          return Response.json({ complete: true, items: urls.map((url) => ({ url })) });
        case '/aistars/v1/images/edits':
          assert.deepEqual(progress.at(-1), { stage: 'submitting' });
          edits++;
          assert.equal(options.headers['X-Temporary-Media-Batch'], 'batch_1');
          assert.deepEqual(JSON.parse(options.body), {
            model: '即梦-65-seedream-5-lite',
            prompt: 'Combine these',
            aspect_ratio: '3:4',
            resolution: '2K',
            n: 1,
            images: urls,
          });
          return Response.json({ id: 'jimeng_1' });
        case '/aistars/v1/tasks/jimeng_1':
          queries++;
          assert.deepEqual(progress.at(-1), {
            stage: queries === 1 ? 'accepted' : 'retryingResult',
            taskId: 'jimeng_1',
          });
          return Response.json({
            status: 'completed',
            artifacts: [{ key: 'image-0', content_url: artifact }],
          });
        case artifact: {
          downloads++;
          let sentPrefix = false;
          return new Response(
            new ReadableStream({
              pull(controller) {
                if (sentPrefix) controller.error(new TypeError('Download interrupted'));
                else {
                  controller.enqueue(Uint8Array.of(137, 80, 78, 71));
                  sentPrefix = true;
                }
              },
            }),
            { headers: { 'Content-Type': 'image/png' } },
          );
        }
        case artifact + '?source=backup':
          downloads++;
          assert.deepEqual(progress.at(-1), { stage: 'downloading', taskId: 'jimeng_1' });
          return image();
        default:
          assert.fail('Unexpected route: ' + url);
      }
    },
    (update) => progress.push(update),
  );
  assert.deepEqual(uploads, ['pose.png', 'costume.png']);
  assert.equal(edits, 1);
  assert.equal(queries, 2);
  assert.equal(downloads, 2);
  assert.equal(jimeng, 'data:image/png;base64,' + png);
});

test('recovering an existing task retries one transient query and never submits a generation', async () => {
  let queries = 0;
  const progress = [];
  const image = await api.resumeReferenceImage(
    { ...config, model: 'gpt-image-2' },
    'task_previous',
    new AbortController().signal,
    async (url, options) => {
      assert.equal(url, '/__canvaspro/kr/v1/images/tasks/task_previous');
      assert.equal(options.method, undefined);
      queries++;
      if (queries === 1) return new Response('Bad gateway', { status: 502 });
      return Response.json({
        status: 'succeeded',
        data: [{ url: 'https://results.example/recovered.png' }],
      });
    },
    (event) => progress.push(event),
  );
  assert.equal(queries, 2);
  assert.deepEqual(
    progress.map((event) => event.stage),
    ['accepted', 'retryingResult'],
  );
  assert.equal(image, 'https://results.example/recovered.png');
});

test('provider errors are redacted and not retried automatically', async () => {
  let calls = 0;
  await assert.rejects(
    api.generateReferenceImage(
      config,
      [references[0]],
      'draw',
      new AbortController().signal,
      async () => {
        calls++;
        return calls === 1
          ? new Response(Buffer.from(png, 'base64'), { headers: { 'Content-Type': 'image/png' } })
          : Response.json({ error: { message: `Rejected ${config.apiKey}` } }, { status: 401 });
      },
    ),
    (error) => error.code === 'providerFailed' && !error.message.includes(config.apiKey),
  );
  assert.equal(calls, 2);
});

test('HTTP 400 responses surface the provider error without exposing the key', async () => {
  let calls = 0;
  await assert.rejects(
    api.generateReferenceImage(
      config,
      [references[0]],
      'draw',
      new AbortController().signal,
      async () => {
        calls++;
        return calls === 1
          ? new Response(Buffer.from(png, 'base64'), { headers: { 'Content-Type': 'image/png' } })
          : Response.json(
              {
                error: {
                  message: `Safety rejected\nReference URL: https://example.com/asset?token=${config.apiKey}`,
                  hint: 'Check the reference image.',
                },
              },
              { status: 400 },
            );
      },
    ),
    (error) =>
      error.code === 'providerFailed' &&
      error.platformMessage ===
        'Safety rejected\nReference URL: https://example.com/asset?token=[redacted]\nCheck the reference image.' &&
      !error.message.includes(config.apiKey),
  );
  assert.equal(calls, 2);
});

test('invalid results and non-image references fail instead of displaying arbitrary content', async () => {
  for (const payload of [
    null,
    {},
    { data: [{ b64_json: 'x' }] },
    { data: [{ url: 'javascript:alert(1)' }] },
    { data: [{ url: 'data:image/svg+xml,test' }] },
  ])
    assert.throws(() => api.imageResult(payload));
  assert.equal(
    api.imageResult({ data: [{ url: 'https://images.example/result.png' }] }),
    'https://images.example/result.png',
  );
  let calls = 0;
  await assert.rejects(
    api.generateReferenceImage(
      config,
      [references[0]],
      'draw',
      new AbortController().signal,
      async () => {
        calls++;
        return new Response('<html>error</html>', { headers: { 'Content-Type': 'text/html' } });
      },
    ),
    (error) => error.code === 'referenceFailed',
  );
  assert.equal(calls, 1);
});

test('cancelled requests are distinct from network errors and never continue to the provider', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    api.generateReferenceImage(
      config,
      references,
      'draw',
      controller.signal,
      async (_url, options) => {
        options.signal.throwIfAborted();
      },
    ),
    (error) => error.code === 'cancelled',
  );
  const prompt = api.referencePrompt(references, 'en');
  assert.ok(prompt.includes('Reference 1 (pose)'));
  assert.ok(prompt.includes('Reference 2 (costume)'));
});

const characterReference = {
  kind: 'character',
  title: { zh: '人物参考', en: 'Character reference' },
  keywords: { zh: '保留人物身份与画风', en: 'Preserve character identity and visual style' },
  file: new File([Buffer.from(png, 'base64')], 'private-personal-name.png', { type: 'image/png' }),
  variant: {
    id: 'character-upload',
    image: 'blob:local-preview',
    thumbnail: 'blob:local-preview',
    original: 'blob:local-preview',
  },
};

test('optional character is a third original file without fetching its preview or exposing its filename', async () => {
  const refs = [...references, characterReference];
  const calls = [];
  await api.generateReferenceImage(
    config,
    refs,
    api.referencePrompt(refs, 'en'),
    new AbortController().signal,
    async (url, options) => {
      calls.push({ url, options });
      return calls.length <= 2
        ? new Response(Buffer.from(png, 'base64'), { headers: { 'Content-Type': 'image/png' } })
        : Response.json({ data: [{ b64_json: png }] });
    },
  );
  assert.equal(calls.length, 3);
  assert.deepEqual(
    calls.slice(0, 2).map((call) => call.url),
    references.map((ref) => ref.variant.original),
  );
  assert.ok(calls.slice(0, 2).every((call) => call.options.headers === undefined));
  const form = calls[2].options.body;
  const files = form.getAll('image[]');
  assert.equal(files.length, 3);
  assert.equal(files[2].name, 'character-upload.png');
  assert.deepEqual(Buffer.from(await files[2].arrayBuffer()), Buffer.from(png, 'base64'));
  assert.match(form.get('prompt'), /Reference 3 \(character\)/);
  assert.match(form.get('prompt'), /identity and visual style/);
  assert.ok(!form.get('prompt').includes(characterReference.file.name));
});

test('character prompts describe actual role order in both languages without changing the two-reference workflow', () => {
  const refs = [references[1], references[0], characterReference];
  const en = api.referencePrompt(refs, 'en');
  assert.match(en, /Reference 1 \(costume\)/);
  assert.match(en, /Reference 2 \(pose\)/);
  assert.match(en, /Reference 3 \(character\)/);
  const zh = api.referencePrompt(refs, 'zh');
  assert.match(zh, /参考图 1（服装）/);
  assert.match(zh, /参考图 3（人物）/);
  assert.match(zh, /保留其五官/);
  const original = api.referencePrompt(references, 'en');
  assert.match(original, /^Create a finished character illustration/);
  assert.ok(!original.includes('character reference'));
});

test('catalog search metadata cannot request a multi-view sheet or override the selected pose', () => {
  const refs = [...references, characterReference].map((ref) => ({
    ...ref,
    title: { zh: '五视角角色设定页', en: 'Five-view character sheet' },
    keywords: {
      zh: '图书馆提取 五视角 正面 侧面 头肩裁切 双手放到身后',
      en: 'library extraction five views front side head-and-shoulders crop hands behind the back',
    },
  }));
  for (const count of [2, 3]) {
    for (const lang of ['zh', 'en']) {
      const prompt = api.referencePrompt(refs.slice(0, count), lang);
      for (const ref of refs) {
        assert.ok(!prompt.includes(ref.title[lang]));
        assert.ok(!prompt.includes(ref.keywords[lang]));
      }
      assert.doesNotMatch(prompt, /五视角|five views/i);
      assert.match(
        prompt,
        lang === 'zh' ? /一个人物、一个选定视角/ : /one person and one selected viewpoint/,
      );
      assert.match(
        prompt,
        lang === 'zh' ? /手势、腿部弯曲及遮挡关系/ : /hand gestures, bent legs and occlusion/,
      );
      assert.match(prompt, lang === 'zh' ? /禁止多面板/ : /No panels/);
    }
  }
});

test('invalid character uploads are rejected before making any network request', async () => {
  const invalid = [
    [new File(['<svg/>'], 'spoof.png', { type: 'image/png' }), 'characterInvalid'],
    [new File([], 'empty.png', { type: 'image/png' }), 'characterInvalid'],
    [
      new File([Buffer.from(png, 'base64')], 'wrong.jpg', { type: 'image/jpeg' }),
      'characterInvalid',
    ],
    [
      new File([new Uint8Array(10 * 1024 * 1024 + 1)], 'large.png', { type: 'image/png' }),
      'characterTooLarge',
    ],
  ];
  for (const [file, code] of invalid) {
    let calls = 0;
    await assert.rejects(
      api.generateReferenceImage(
        config,
        [...references, { ...characterReference, file }],
        'draw',
        new AbortController().signal,
        async () => {
          calls++;
        },
      ),
      (error) => error.code === code,
    );
    assert.equal(calls, 0);
  }
});

test('adding a character does not relax the gallery origin restriction', async () => {
  let calls = 0;
  const untrusted = {
    ...references[0],
    variant: { ...references[0].variant, original: 'https://untrusted.example/pose.png' },
  };
  await assert.rejects(
    api.generateReferenceImage(
      config,
      [untrusted, references[1], characterReference],
      'draw',
      new AbortController().signal,
      async () => {
        calls++;
      },
    ),
    (error) => error.code === 'referenceFailed',
  );
  assert.equal(calls, 0);
});

test('library character is fetched as a third original and uploaded with no API key sent to the source', async () => {
  const galleryCharacter = {
    kind: 'character',
    title: { zh: '人物', en: 'Character' },
    keywords: { zh: '保留人物身份', en: 'Preserve identity' },
    variant: { id: 'f123', original: 'https://ai-portrait-gallery.pages.dev/img/full/f123.png' },
  };
  const refs = [...references, galleryCharacter];
  const calls = [];
  await api.generateReferenceImage(
    config,
    refs,
    api.referencePrompt(refs, 'en'),
    new AbortController().signal,
    async (url, options) => {
      calls.push({ url, options });
      return calls.length <= 3
        ? new Response(Buffer.from(png, 'base64'), { headers: { 'Content-Type': 'image/png' } })
        : Response.json({ data: [{ b64_json: png }] });
    },
  );
  assert.deepEqual(
    calls.slice(0, 3).map((call) => call.url),
    refs.map((ref) => ref.variant.original),
  );
  assert.ok(calls.slice(0, 3).every((call) => call.options.headers === undefined));
  const form = calls[3].options.body;
  assert.equal(form.getAll('image[]').length, 3);
  assert.equal(form.getAll('image[]')[2].name, 'f123.png');
  assert.match(form.get('prompt'), /Reference 3 \(character\)/);
  galleryCharacter.variant.original = 'https://other.example/person.png';
  await assert.rejects(
    api.generateReferenceImage(
      config,
      [galleryCharacter],
      'draw',
      new AbortController().signal,
      async () => {
        throw Error('Must not fetch an untrusted origin');
      },
    ),
    (error) => error.code === 'referenceFailed',
  );
});

test('depth pose uploads the selected depth original and explains depth without granting other kinds access', async () => {
  const pose = {
    ...references[0],
    variant: {
      ...references[0].variant,
      original: 'https://ai-pose-depth-gallery.pages.dev/img/full_single_P001_side.png',
    },
  };
  const refs = [pose, references[1]];
  assert.match(api.referencePrompt(refs, 'zh'), /此图为深度图/);
  assert.match(api.referencePrompt(refs, 'en'), /This is a depth map/);
  const calls = [];
  await api.generateReferenceImage(
    config,
    refs,
    api.referencePrompt(refs, 'en'),
    new AbortController().signal,
    async (url, options) => {
      calls.push({ url, options });
      return calls.length <= 2
        ? new Response(Buffer.from(png, 'base64'), { headers: { 'Content-Type': 'image/png' } })
        : Response.json({ data: [{ b64_json: png }] });
    },
  );
  assert.equal(calls[0].url, pose.variant.original);
  assert.equal(calls[0].options.headers, undefined);
  assert.equal(calls[0].options.credentials, 'omit');
  const files = calls[2].options.body.getAll('image[]');
  assert.equal(files.length, 2);
  assert.deepEqual(Buffer.from(await files[0].arrayBuffer()), Buffer.from(png, 'base64'));
  for (const kind of ['costume', 'character']) {
    await assert.rejects(
      api.generateReferenceImage(
        config,
        [{ ...pose, kind }],
        'draw',
        new AbortController().signal,
        async () => {
          throw Error('Must not fetch a depth image as a non-pose reference');
        },
      ),
      (error) => error.code === 'referenceFailed',
    );
  }
});

test('uploaded costumes are sent as a file alongside the pose, without fetching previews or leaking local names', async () => {
  const outfit = {
    ...characterReference,
    kind: 'costume',
    title: { zh: '上传的服饰', en: 'Uploaded costume' },
    keywords: { zh: '采用服饰配色与材质', en: 'Use the outfit colors and materials' },
    variant: { ...characterReference.variant, id: 'costume-upload' },
    file: new File([Buffer.from(png, 'base64')], 'private-outfit-name.png', { type: 'image/png' }),
  };
  const refs = [references[0], outfit, characterReference];
  const calls = [];
  await api.generateReferenceImage(
    config,
    refs,
    api.referencePrompt(refs, 'en'),
    new AbortController().signal,
    async (url, options) => {
      calls.push({ url, options });
      return calls.length === 1
        ? new Response(Buffer.from(png, 'base64'), { headers: { 'Content-Type': 'image/png' } })
        : Response.json({ data: [{ b64_json: png }] });
    },
  );
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, references[0].variant.original);
  assert.equal(calls[0].options.headers, undefined);
  const files = calls[1].options.body.getAll('image[]');
  assert.equal(files.length, 3);
  assert.equal(files[1].name, 'costume-upload.png');
  assert.equal(files[2].name, 'character-upload.png');
  assert.deepEqual(Buffer.from(await files[1].arrayBuffer()), Buffer.from(png, 'base64'));
  assert.match(calls[1].options.body.get('prompt'), /Reference 2 \(costume\)/);
  assert.ok(!calls[1].options.body.get('prompt').includes(outfit.file.name));
});

test('invalid and oversized costume uploads fail before any reference or provider request', async () => {
  for (const [file, code] of [
    [new File(['<svg/>'], 'outfit.png', { type: 'image/png' }), 'costumeInvalid'],
    [
      new File([Buffer.from(png, 'base64')], 'outfit.jpg', { type: 'image/jpeg' }),
      'costumeInvalid',
    ],
    [
      new File([new Uint8Array(10 * 1024 * 1024 + 1)], 'outfit.png', { type: 'image/png' }),
      'costumeTooLarge',
    ],
  ]) {
    let calls = 0;
    await assert.rejects(
      api.generateReferenceImage(
        config,
        [references[0], { ...characterReference, kind: 'costume', file }],
        'draw',
        new AbortController().signal,
        async () => {
          calls++;
        },
      ),
      (error) => error.code === code,
    );
    assert.equal(calls, 0);
  }
});

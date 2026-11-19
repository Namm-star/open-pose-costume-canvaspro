import { CANVASPRO_ORIGIN, imageProtocol } from './canvaspro-models';
import { imagePlatformMessage, readImageResponse, redactDiagnostic } from './image-diagnostics';
import type { ImageConfig } from './generation';
import { TRANSFER_PATH, TRANSFER_CHUNK_BYTES, TRANSFER_MAX_BYTES } from './canvaspro-transfer';

const route = '/__canvaspro';
const failedTaskStates = ['failed', 'cancelled', 'canceled'];
const taskPaths = {
  jimeng: '/aistars/v1/tasks/',
  gemini: '/kr/gemini/v1/images/tasks/',
  hc: '/hc/v1/images/tasks/',
  kr: '/kr/v1/images/tasks/',
  'kr-gpt': '/kr/gpt/v1/images/tasks/',
};
export const isCanvasProTaskId = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(value);

export type ImageGenerationProgress =
  | { stage: 'readingReferences' | 'uploadingReferences' | 'submitting' | 'waitingForResponse' }
  | { stage: 'accepted' | 'downloading' | 'retryingResult'; taskId: string };

export class ImageGenerationError extends Error {
  constructor(
    public code: string,
    message = '',
    public readonly platformMessage = '',
    public readonly httpStatus?: number,
  ) {
    super(message);
  }
}

export function imageResult(payload: unknown, apiKey = ''): string {
  const row = (payload as { data?: { b64_json?: unknown; url?: unknown }[] })?.data?.[0];
  if (typeof row?.b64_json === 'string') {
    const b64 = row.b64_json;
    if (b64.length > 100_000_000 || b64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64))
      throw new ImageGenerationError('invalidResult');
    const signature = atob(b64.slice(0, 32));
    const mime = signature.startsWith('\x89PNG\r\n\x1a\n')
      ? 'image/png'
      : signature.startsWith('\xff\xd8\xff')
        ? 'image/jpeg'
        : signature.startsWith('RIFF') && signature.slice(8, 12) === 'WEBP'
          ? 'image/webp'
          : '';
    if (!mime) throw new ImageGenerationError('invalidResult');
    return `data:${mime};base64,${b64}`;
  }
  if (typeof row?.url === 'string') {
    try {
      const url = new URL(row.url);
      if (url.protocol === 'https:' && !url.username && !url.password) return url.href;
    } catch {
      /* Report one consistent error for invalid provider output. */
    }
  }
  throw new ImageGenerationError('invalidResult', '', imagePlatformMessage(payload, apiKey));
}

export function imageDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new ImageGenerationError('invalidResult'));
    reader.readAsDataURL(blob);
  });
}

function delay(milliseconds: number, signal: AbortSignal) {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const stop = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', stop);
      resolve();
    }, milliseconds);
    signal.addEventListener('abort', stop, { once: true });
  });
}

function taskId(value: unknown): string {
  if (!isCanvasProTaskId(value)) throw new ImageGenerationError('invalidResult');
  return value;
}

async function stageBody(
  body: BodyInit,
  signal: AbortSignal,
  fetcher: typeof fetch,
): Promise<{ id: string; contentType: string | null } | undefined> {
  const encoded = new Response(body);
  const blob = await encoded.blob();
  if (blob.size <= TRANSFER_CHUNK_BYTES) return;
  if (blob.size > TRANSFER_MAX_BYTES) throw new ImageGenerationError('referenceTooLarge');

  const id = crypto.randomUUID();
  for (let offset = 0; offset < blob.size; offset += TRANSFER_CHUNK_BYTES) {
    signal.throwIfAborted();
    const result = await fetcher(TRANSFER_PATH + id, {
      method: 'PUT',
      credentials: 'omit',
      redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
      headers: { 'X-Transfer-Offset': String(offset), 'X-Transfer-Length': String(blob.size) },
      body: blob.slice(offset, offset + TRANSFER_CHUNK_BYTES),
    }).catch((error) => {
      if (signal.aborted) throw error;
      throw new ImageGenerationError('localTransferFailed');
    });
    if (!result.ok) throw new ImageGenerationError('localTransferFailed', `HTTP ${result.status}`);
  }
  return { id, contentType: encoded.headers.get('content-type') };
}

function canvasProRequest(apiKey: string, signal: AbortSignal, fetcher: typeof fetch) {
  const auth = { Authorization: `Bearer ${apiKey}` };
  return async (path: string, options: RequestInit = {}) => {
    const requestSignal = options.signal ?? signal;
    const endpoint = route + path;
    const staged = options.body ? await stageBody(options.body, requestSignal, fetcher) : undefined;
    const headers = { ...auth, ...options.headers };
    if (staged) {
      Object.assign(headers, {
        'X-CanvasPro-Transfer': staged.id,
        ...(!new Headers(headers).has('content-type') && staged.contentType
          ? { 'Content-Type': staged.contentType }
          : {}),
      });
    }
    const response = await fetcher(endpoint, {
      ...options,
      body: staged ? undefined : options.body,
      headers,
      credentials: 'omit',
      redirect: 'error',
      signal: requestSignal,
    });
    if (response.ok && /\/artifacts\/image-\d+\/content(?:\?source=backup)?$/.test(path))
      return response;
    const { payload, diagnostic, platformMessage } = await readImageResponse(
      response,
      'canvaspro-image',
      endpoint,
      apiKey,
    );
    const failedTask = path.includes('/tasks/') && failedTaskStates.includes(payload?.status);
    if (!response.ok || !payload || (!failedTask && (payload.error || payload.success === false))) {
      const detail = diagnostic || platformMessage || `HTTP ${response.status}`;
      throw new ImageGenerationError(
        response.status === 403
          ? 'accessDenied'
          : response.ok && !payload
            ? 'invalidResult'
            : path === '/v1/media/uploads'
              ? 'referenceUploadRejected'
              : 'providerFailed',
        detail,
        platformMessage,
        response.status,
      );
    }
    return payload;
  };
}

export async function editCanvasProImage(
  config: ImageConfig,
  images: File[],
  prompt: string,
  signal: AbortSignal,
  fetcher: typeof fetch,
  onProgress?: (progress: ImageGenerationProgress) => void,
): Promise<string> {
  const { model, size, quality, apiKey } = config;
  const protocol = imageProtocol(model);
  const request = canvasProRequest(apiKey, signal, fetcher);
  const postJson = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });

  const [aspectRatio, resolution] = size.split(' · ');
  let receipt;
  if (protocol === 'gemini') {
    const parts = await Promise.all(
      images.map(async (file) => ({
        inlineData: { mimeType: file.type, data: (await imageDataUrl(file)).split(',', 2)[1] },
      })),
    );
    onProgress?.({ stage: 'submitting' });
    receipt = await postJson('/kr/gemini/v1/images/generations', {
      model,
      contents: [{ role: 'user', parts: [{ text: prompt }, ...parts] }],
      generationConfig: { imageConfig: { aspectRatio, imageSize: resolution } },
    });
  } else if (protocol === 'jimeng') {
    onProgress?.({ stage: 'uploadingReferences' });
    const batch = taskId(
      (await postJson('/v1/media/batches', { model, expected_count: images.length })).id,
    );
    const batchHeader = { 'X-Temporary-Media-Batch': batch };
    const uploads: string[] = [];
    for (const [index, image] of images.entries()) {
      const form = new FormData();
      form.set('model', model);
      form.set('purpose', 'reference_image');
      form.set('file', image);
      const item = await request('/v1/media/uploads', {
        method: 'POST',
        headers: { ...batchHeader, 'X-Temporary-Media-Index': String(index + 1) },
        body: form,
      });
      uploads.push(taskId(item.id));
    }
    await Promise.all(
      uploads.map(async (id) => {
        for (;;) {
          const item = await request('/v1/media/uploads/' + id);
          if (item.state === 'ready') return;
          if (['failed', 'expired', 'deleted'].includes(item.state))
            throw new ImageGenerationError(
              'referenceFailed',
              `${id} · ${redactDiagnostic(String(item.error_code || item.state), apiKey)}`,
              imagePlatformMessage(item, apiKey),
            );
          await delay(2_000, signal);
        }
      }),
    );
    const group = await request('/v1/media/batches/' + batch);
    if (!group.complete || group.items?.length !== images.length)
      throw new ImageGenerationError('referenceFailed');
    const urls = group.items.map((item: { url: string }) => {
      const url = new URL(item.url);
      if (url.origin !== CANVASPRO_ORIGIN || !url.pathname.startsWith('/v1/media/files/'))
        throw new ImageGenerationError('referenceFailed');
      return url.href;
    });
    onProgress?.({ stage: 'submitting' });
    receipt = await postJson(
      '/aistars/v1/images/edits',
      {
        model,
        prompt,
        aspect_ratio: aspectRatio,
        resolution,
        n: 1,
        images: urls,
      },
      batchHeader,
    );
  } else {
    const form = new FormData();
    form.set('model', model);
    form.set('prompt', prompt);
    form.set('n', '1');
    if (size !== 'auto') form.set('size', size);
    if (quality !== 'auto') form.set('quality', quality);
    if (model.endsWith('-W')) form.set('output_format', 'png');
    const field =
      protocol === 'hc' || (protocol.startsWith('kr') && images.length === 1) ? 'image' : 'image[]';
    for (const image of images) form.append(field, image);
    const submitPath = {
      sync: '/v1/images/edits',
      kr: '/kr/v1/images/edits',
      'kr-gpt': '/kr/gpt/v1/images/edits',
      hc: '/hc/v1/images/edits/upload',
    }[protocol];
    onProgress?.({ stage: protocol === 'sync' ? 'waitingForResponse' : 'submitting' });
    receipt = await request(submitPath, { method: 'POST', body: form });
    if (protocol === 'sync') return imageResult(receipt, apiKey);
  }

  let id: string;
  try {
    id = taskId(protocol === 'jimeng' ? receipt.id : receipt.task_id);
  } catch {
    throw new ImageGenerationError(
      'submissionReceiptMissing',
      '',
      imagePlatformMessage(receipt, apiKey),
    );
  }
  return readCanvasProTask(model, apiKey, id, signal, fetcher, onProgress);
}

function retryableResultError(error: unknown): boolean {
  if (!(error instanceof ImageGenerationError) || error.code === 'invalidResult') return true;
  const status = error.httpStatus ?? 0;
  return [404, 408, 409, 425, 429].includes(status) || status >= 500;
}

export async function readCanvasProTask(
  model: string,
  apiKey: string,
  id: string,
  signal: AbortSignal,
  fetcher: typeof fetch,
  onProgress?: (progress: ImageGenerationProgress) => void,
  preferBackup = false,
): Promise<string> {
  const protocol = imageProtocol(model);
  if (protocol === 'sync' || !isCanvasProTaskId(id))
    throw new ImageGenerationError('invalidTaskId');
  const request = canvasProRequest(apiKey, signal, fetcher);
  const requestSignal = (milliseconds: number) =>
    AbortSignal.any([signal, AbortSignal.timeout(milliseconds)]);
  let retried = false;
  onProgress?.({ stage: 'accepted', taskId: id });
  try {
    for (;;) {
      signal.throwIfAborted();
      try {
        const task = await request(taskPaths[protocol] + id, { signal: requestSignal(35_000) });
        if (typeof task.status !== 'string') throw new ImageGenerationError('invalidResult');
        if (task.status === 'succeeded' && protocol !== 'jimeng') return imageResult(task, apiKey);
        if (task.status === 'completed' && protocol === 'jimeng') {
          const artifact = task.artifacts?.find((item: { key?: string }) =>
            /^image-\d+$/.test(item.key || ''),
          );
          if (!artifact?.content_url) throw new ImageGenerationError('invalidResult');
          const path = `/v1/tasks/${id}/artifacts/${artifact.key}/content`;
          const url = new URL(artifact.content_url, CANVASPRO_ORIGIN);
          if (url.origin !== CANVASPRO_ORIGIN || url.pathname !== path)
            throw new ImageGenerationError('invalidResult');
          onProgress?.({ stage: 'downloading', taskId: id });
          const response: Response = await request(
            path + (retried !== preferBackup ? '?source=backup' : ''),
            {
              signal: requestSignal(90_000),
            },
          );
          const data = await imageDataUrl(await response.blob());
          return imageResult({ data: [{ b64_json: data.split(',', 2)[1] }] }, apiKey);
        }
        if (failedTaskStates.includes(task.status)) {
          const message = imagePlatformMessage(task, apiKey);
          throw new ImageGenerationError('taskFailed', message || task.status, message);
        }
        if (retried) onProgress?.({ stage: 'accepted', taskId: id });
        retried = false;
      } catch (error) {
        if (signal.aborted || retried || !retryableResultError(error)) throw error;
        retried = true;
        onProgress?.({ stage: 'retryingResult', taskId: id });
        await delay(1_000, signal);
        continue;
      }
      await delay(protocol === 'jimeng' ? 10_000 : 3_000, signal);
    }
  } catch (error) {
    const failure = error instanceof ImageGenerationError ? error : undefined;
    const code = failure?.code ?? (signal.aborted ? 'timedOut' : 'networkFailed');
    const detail = failure?.message ? `\n${failure.message}` : '';
    throw new ImageGenerationError(
      code,
      `CanvasPro task: ${id}${detail}`,
      failure?.platformMessage,
      failure?.httpStatus,
    );
  }
}

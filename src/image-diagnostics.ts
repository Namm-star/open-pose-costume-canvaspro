function redactPrivateText(value: string, secret: string): string {
  const text = secret ? value.split(secret).join('[redacted]') : value;
  return text
    .replace(/Bearer\s+[^\s"<>]+/gi, 'Bearer [redacted]')
    .replace(/\bsk-[\w-]+/g, '[redacted]')
    .replace(/data:image\/[^\s"<>]+/gi, '[image omitted]')
    .replace(/([?&][\w-]+=)[^\s&#"<>]*/g, '$1[redacted]')
    .replace(/[A-Za-z0-9+/]{120,}={0,2}/g, '[data omitted]');
}

/** Never include request bodies, credentials, query values or image responses. */
export function redactDiagnostic(value: string, secret = ''): string {
  return redactPrivateText(value, secret)
    .replace(/[\u0000-\u001f]/g, ' ')
    .slice(0, 800);
}

export function imagePlatformMessage(payload: unknown, secret = ''): string {
  const fields = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
  const error =
    fields.error && typeof fields.error === 'object'
      ? (fields.error as Record<string, unknown>)
      : {};
  const candidate = [
    error.message,
    error.detail,
    error.reason,
    fields.error,
    fields.failure_reason,
    fields.fail_reason,
    fields.reason,
    fields.error_description,
    fields.message,
    fields.detail,
    error.code,
    fields.error_code,
    payload,
  ].find((value): value is string => typeof value === 'string' && value.trim() !== '');
  const hint = [error.hint, fields.hint].find(
    (value): value is string => typeof value === 'string' && value.trim() !== '',
  );
  const message = [candidate, hint === candidate ? undefined : hint].filter(Boolean).join('\n');
  return redactPrivateText(message, secret)
    .replace(/[\u0000-\u0008\u000b-\u001f]/g, ' ')
    .trim()
    .slice(0, 1600);
}

export async function readImageResponse(
  response: Response,
  stage: string,
  endpoint: string,
  secret = '',
) {
  let payload: any = null;
  // Inspect a bounded prefix for errors; never retain successful image payloads in diagnostics.
  if (response.ok) {
    payload = await response.json().catch(() => null);
    return { payload, diagnostic: '', platformMessage: imagePlatformMessage(payload, secret) };
  }
  const reader = response.body?.getReader();
  const decoder = new TextDecoder();
  let body = '';
  try {
    while (reader && body.length < 4096) {
      const part = await reader.read();
      if (part.done) break;
      body += decoder.decode(part.value.subarray(0, 4096 - body.length), { stream: true });
    }
    body += decoder.decode();
  } catch {
    // A truncated error body can still provide an HTTP status and request ID.
  } finally {
    await reader?.cancel().catch(() => undefined);
  }
  try {
    payload = JSON.parse(body);
  } catch {
    /* HTML and text errors remain readable. */
  }
  const url = new URL(
    endpoint,
    typeof location === 'undefined' ? 'http://localhost' : location.origin,
  );
  const contentType = response.headers.get('content-type') || '';
  const requestId =
    response.headers.get('x-request-id') ||
    response.headers.get('x-oneapi-request-id') ||
    response.headers.get('cf-ray') ||
    '';
  const plainText =
    contentType.includes('text/html') || /^\s*</.test(body)
      ? (body.match(/<(h1|title)\b[^>]*>([\s\S]*?)<\/\1>/i)?.[2] || '').replace(/<[^>]*>/g, ' ')
      : /^[\s]*[\[{]/.test(body)
        ? ''
        : body;
  const diagnostic = JSON.stringify(
    {
      time: new Date().toISOString(),
      stage,
      endpoint: url.origin + url.pathname,
      status: response.status,
      contentType: redactDiagnostic(contentType, secret),
      requestId: redactDiagnostic(requestId, secret),
      response: redactDiagnostic(body.replace(/<[^>]*>/g, ' '), secret),
    },
    null,
    2,
  );
  return {
    payload,
    diagnostic,
    platformMessage: imagePlatformMessage(payload ?? plainText, secret),
  };
}

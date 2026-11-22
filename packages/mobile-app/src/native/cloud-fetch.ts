import { CapacitorHttp } from '@capacitor/core';

import { decodeBase64, encodeBase64 } from './upload-files.js';

/** Android's HTTP bridge supports private R2 responses and sends a fixed-length binary PUT. */
export const androidCloudFetch: typeof fetch = async (input, init) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new TypeError('Cloud sync requires a HTTPS URL without embedded credentials');
  }
  const image = url.pathname.startsWith('/api/sync/images/');
  const headers = Object.fromEntries(request.headers);
  // The native bridge uses the canonical Content-Type key when serializing a request body.
  if (headers['content-type']) {
    headers['Content-Type'] = headers['content-type'];
    delete headers['content-type'];
  }
  const binaryUpload = image && request.method === 'PUT' && request.body !== null;
  const data = binaryUpload
    ? encodeBase64(new Uint8Array(await request.arrayBuffer()))
    : request.body
      ? await request.text()
      : undefined;
  const result = await CapacitorHttp.request({
    url: url.href,
    method: request.method,
    headers,
    data,
    ...(binaryUpload ? { dataType: 'file' } : {}),
    responseType: image && request.method === 'GET' ? 'arraybuffer' : 'text',
    disableRedirects: true,
    connectTimeout: 15_000,
    readTimeout: 45_000,
  });
  if (result.status >= 300 && result.status < 400) throw new TypeError('Cloud redirect refused');
  if (new URL(result.url).origin !== url.origin)
    throw new TypeError('Cloud response origin changed');
  const responseHeaders = new Headers();
  for (const [name, value] of Object.entries(result.headers)) {
    if (/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) responseHeaders.set(name, value);
  }
  let body: BodyInit | null = null;
  if (result.status !== 204 && result.status !== 205 && request.method !== 'HEAD') {
    if (image && request.method === 'GET' && result.status === 200) {
      body = decodeBase64(result.data as string);
    } else {
      body = typeof result.data === 'string' ? result.data : JSON.stringify(result.data);
    }
  }
  return new Response(body, { status: result.status, headers: responseHeaders });
};

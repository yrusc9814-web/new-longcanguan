import { HOUSEHOLD_EPOCH_HEADER, IMAGE_CONTENT_SHA256_HEADER } from '@dafan/shared/sync';

import type { HouseholdHub } from './household-hub';
import { cloudError } from './http';
import type { ImageTarget, PendingImageUpload } from './image-protocol';

const INTERNAL_ERROR = { code: 'INTERNAL_ERROR', status: 500 } as const;
const INVALID_FILE = { code: 'INVALID_FILE', status: 400 } as const;
const NOT_FOUND = { code: 'NOT_FOUND', status: 404 } as const;

export async function proxyImage(
  request: Request,
  url: URL,
  assetSha256: string,
  hub: DurableObjectStub<HouseholdHub>,
  bucket: R2Bucket,
): Promise<Response> {
  const target: ImageTarget = { assetSha256, variant: url.searchParams.get('variant') };
  const authorization = request.headers.get('authorization');

  if (request.method === 'GET') {
    const lookup = await hub.readImage(authorization, target);
    if ('code' in lookup) return cloudError(lookup);
    const object = await bucket.get(lookup.objectKey);
    const current = await hub.readImage(authorization, target);
    if ('code' in current || current.objectKey !== lookup.objectKey) {
      await object?.body.cancel().catch(() => undefined);
      return cloudError('code' in current ? current : NOT_FOUND);
    }
    if (!object) return cloudError(NOT_FOUND);

    const headers = new Headers({
      'cache-control': 'private, no-store',
      'content-length': String(object.size),
      'x-content-type-options': 'nosniff',
      etag: object.httpEtag,
    });
    object.writeHttpMetadata(headers);
    return new Response(object.body, { headers });
  }

  const preflight = await hub.preflightImage(authorization, {
    ...target,
    epoch: request.headers.get(HOUSEHOLD_EPOCH_HEADER),
    contentType: request.headers.get('content-type'),
    contentLength: request.headers.get('content-length'),
    contentSha256: request.headers.get(IMAGE_CONTENT_SHA256_HEADER),
  });
  if ('code' in preflight) return cloudError(preflight);
  if (preflight.kind === 'existing') return new Response(null, { status: 204 });
  if (!request.body) return cloudError(INVALID_FILE);

  const { upload } = preflight;
  const writeFailure = await putImage(request.body, bucket, upload);
  if (writeFailure) return writeFailure;

  try {
    const commit = await hub.commitImage(authorization, upload);
    if ('code' in commit) {
      return await deleteUpload(bucket, upload.objectKey, cloudError(commit));
    }
    const success = new Response(null, { status: 204 });
    return commit.kind === 'registered'
      ? success
      : await deleteUpload(bucket, upload.objectKey, success);
  } catch {
    return deleteUpload(bucket, upload.objectKey, cloudError(INTERNAL_ERROR));
  }
}

async function putImage(
  body: ReadableStream,
  bucket: R2Bucket,
  upload: PendingImageUpload,
): Promise<Response | undefined> {
  const stream = new FixedLengthStream(upload.sizeBytes);
  const abort = new AbortController();
  const write = bucket.put(upload.objectKey, stream.readable, {
    httpMetadata: { contentType: upload.mimeType },
    sha256: upload.contentSha256,
  });
  const transfer = body.pipeTo(stream.writable, { signal: abort.signal });

  try {
    await Promise.all([write, transfer]);
  } catch (error) {
    abort.abort();
    await Promise.allSettled([write, transfer]);
    const invalid =
      error instanceof Error && /length|bytes|checksum|digest|hash/i.test(error.message);
    return deleteUpload(
      bucket,
      upload.objectKey,
      cloudError(invalid ? INVALID_FILE : INTERNAL_ERROR),
    );
  }
}

async function deleteUpload(bucket: R2Bucket, key: string, response: Response): Promise<Response> {
  try {
    await bucket.delete(key).catch(() => bucket.delete(key));
    return response;
  } catch {
    return cloudError(INTERNAL_ERROR);
  }
}

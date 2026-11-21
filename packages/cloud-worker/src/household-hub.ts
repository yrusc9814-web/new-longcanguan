import { DurableObject } from 'cloudflare:workers';

import { hashBearer, requireMember } from './auth';
import { cloudError, type CloudFailure } from './http';
import {
  parseImageTarget,
  parseImageUpload,
  type ImageCommit,
  type ImagePreflight,
  type ImageRead,
  type ImageTarget,
  type ImageUploadRequest,
  type PendingImageUpload,
} from './image-protocol';
import type { Env } from './index';
import { migrateHousehold } from './schema';

const EPOCH_MISMATCH = { code: 'EPOCH_MISMATCH', status: 409 } as const;
const IMAGE_CONFLICT = { code: 'CONFLICT', status: 409 } as const;
const NOT_FOUND = { code: 'NOT_FOUND', status: 404 } as const;

export class HouseholdHub extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => migrateHousehold(ctx.storage));
  }

  async fetch(): Promise<Response> {
    return cloudError(NOT_FOUND);
  }

  // These image methods are internal Durable Object RPCs. The public Worker exposes only HTTP.
  async preflightImage(
    authorization: string | null,
    request: ImageUploadRequest,
  ): Promise<ImagePreflight> {
    const sql = this.ctx.storage.sql;
    const member = requireMember(sql, await hashBearer(authorization));
    if ('code' in member) return member;

    const epoch = this.#currentEpoch();
    if (request.epoch !== String(epoch)) return EPOCH_MISMATCH;

    const image = parseImageUpload(request);
    if ('code' in image) return image;

    const existing = this.#findImage(image.assetSha256, image.variant);
    if (existing) {
      return existing.content_sha256 === image.contentSha256
        ? { kind: 'existing' }
        : IMAGE_CONFLICT;
    }

    const objectKey = `images/${image.assetSha256}/${image.variant}/${crypto.randomUUID()}`;
    return { kind: 'upload', upload: { ...image, epoch, objectKey } };
  }

  async commitImage(authorization: string | null, image: PendingImageUpload): Promise<ImageCommit> {
    const hash = await hashBearer(authorization);
    const storage = this.ctx.storage;
    return storage.transactionSync(() => {
      const sql = storage.sql;
      const member = requireMember(sql, hash);
      if ('code' in member) return member;
      if (image.epoch !== this.#currentEpoch()) return EPOCH_MISMATCH;

      const existing = this.#findImage(image.assetSha256, image.variant);
      if (existing) {
        if (existing.object_key === image.objectKey) return { kind: 'registered' };
        return existing.content_sha256 === image.contentSha256
          ? { kind: 'existing' }
          : IMAGE_CONFLICT;
      }

      sql.exec(
        `INSERT INTO image_objects
          (asset_sha256, variant, object_key, content_sha256, mime_type, size_bytes, epoch, uploaded_by, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
        image.assetSha256,
        image.variant,
        image.objectKey,
        image.contentSha256,
        image.mimeType,
        image.sizeBytes,
        image.epoch,
        member.id,
      );
      return { kind: 'registered' };
    });
  }

  async readImage(authorization: string | null, target: ImageTarget): Promise<ImageRead> {
    const member = requireMember(this.ctx.storage.sql, await hashBearer(authorization));
    if ('code' in member) return member;

    const image = parseImageTarget(target);
    if (!image) return { code: 'VALIDATION_ERROR', status: 400 } satisfies CloudFailure;
    const entry = this.#findImage(image.assetSha256, image.variant);
    return entry ? { kind: 'found', objectKey: entry.object_key } : NOT_FOUND;
  }

  #currentEpoch(): number {
    return this.ctx.storage.sql
      .exec<{ epoch: number }>('SELECT epoch FROM household_meta WHERE id = 1')
      .one().epoch;
  }

  #findImage(assetSha256: string, variant: string) {
    return this.ctx.storage.sql
      .exec<{ content_sha256: string; object_key: string }>(
        'SELECT content_sha256, object_key FROM image_objects WHERE asset_sha256 = ? AND variant = ?',
        assetSha256,
        variant,
      )
      .toArray()[0];
  }
}

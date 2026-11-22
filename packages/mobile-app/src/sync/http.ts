/**
 * 云端同步 HTTP 传输层：同源限制、代际捕获与可信撤权判定集中在此。
 *
 * 安全边界（任一不满足都不得触发本地清退）：
 * 1. 请求目标必须与当前绑定 `cloudOrigin` 原始同源；跨域重定向一律不跟随
 *    （`redirect: 'manual'`），出现任何 3xx/不透明重定向按网络错误处理。
 * 2. 撤权证据必须同时满足：HTTP 403 + `code === 'MEMBER_REVOKED'` +
 *    响应 `householdId/memberId` 与请求发起时捕获的绑定一致 +
 *    请求发起时的 `bindingGeneration` 仍等于当前最新代际。
 * 3. 401 / 403 FORBIDDEN / 429 / 5xx / 断网 / 旧代际迟到响应都只作为普通错误返回。
 */
import { HOUSEHOLD_EPOCH_HEADER, type HouseholdRole } from '@dafan/shared/sync';

export type SyncFetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface SyncHttpContext {
  readonly cloudOrigin: string;
  readonly householdId: string;
  readonly memberId: string;
  readonly role: HouseholdRole;
  /** 仅用于撤权对比与请求头；不含 token。 */
  readonly generation: number;
  readonly epoch: number;
  readonly token: string;
}

export type SyncContextProvider = () => Promise<SyncHttpContext | null>;

export interface RevocationEvidence {
  readonly householdId: string;
  readonly memberId: string;
  readonly generation: number;
  readonly source: 'http' | 'websocket';
}

export class SyncHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly body: unknown = null,
  ) {
    super(message);
    this.name = 'SyncHttpError';
  }
}

export class SyncNetworkError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'SyncNetworkError';
  }
}

export class EpochMismatchError extends SyncHttpError {
  constructor(readonly currentEpoch: number) {
    super(409, 'EPOCH_MISMATCH', `云端账本代际已切换为 ${currentEpoch}`, {
      code: 'EPOCH_MISMATCH',
      currentEpoch,
    });
    this.name = 'EpochMismatchError';
  }
}

export class TrustedRevocationError extends SyncHttpError {
  constructor(
    readonly householdId: string,
    readonly memberId: string,
    readonly generation: number,
  ) {
    super(403, 'MEMBER_REVOKED', '成员权限已被移除', {
      code: 'MEMBER_REVOKED',
      householdId,
      memberId,
    });
    this.name = 'TrustedRevocationError';
  }
}

export class RateLimitedError extends SyncHttpError {
  constructor(readonly retryAfterMs: number) {
    super(429, 'RATE_LIMITED', '云端限流，需退避重试');
    this.name = 'RateLimitedError';
  }
}

interface ErrorBody {
  code?: unknown;
  currentEpoch?: unknown;
  householdId?: unknown;
  memberId?: unknown;
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function retryAfterMs(response: Response, body: ErrorBody): number {
  const header = Number(response.headers.get('retry-after'));
  if (Number.isFinite(header) && header > 0) return Math.min(header, 3600) * 1000;
  const details = (body as { details?: { retryAfter?: unknown } }).details;
  const seconds = Number(details?.retryAfter);
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 3600) * 1000 : 30_000;
}

export interface SyncHttpClientOptions {
  readonly fetch?: SyncFetch;
  readonly context: SyncContextProvider;
  /** 当前配置的云端源（绑定前也必须有值）；缺省回退到绑定上下文。 */
  readonly origin?: () => Promise<string | null> | string | null;
  /** 只在可信撤权证据成立时调用；必须幂等。 */
  readonly onRevoked?: (evidence: RevocationEvidence) => void | Promise<void>;
}

export interface SyncRequestOptions {
  readonly method?: 'GET' | 'POST' | 'PUT';
  readonly body?: BodyInit;
  readonly headers?: Record<string, string>;
  /** 跳过绑定检查（绑定/加入家庭等尚未持有 token 的请求）。 */
  readonly anonymous?: boolean;
  /** 覆盖 x-household-epoch（首次初始化上传时本机尚未切换到新代际）。 */
  readonly epoch?: number;
}

export class SyncHttpClient {
  private readonly fetchImpl: SyncFetch;

  constructor(private readonly options: SyncHttpClientOptions) {
    this.fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  }

  /** 读取当前绑定上下文；未绑定时返回 null。 */
  context(): Promise<SyncHttpContext | null> {
    return this.options.context();
  }

  private async resolveOrigin(context: SyncHttpContext | null): Promise<string | null> {
    if (context) return context.cloudOrigin;
    return (await this.options.origin?.()) ?? null;
  }

  async request(path: string, options: SyncRequestOptions = {}): Promise<unknown> {
    const { response, context } = await this.send(path, options);
    if (response.ok) return readJson(response);
    throw await this.failure(response, context);
  }

  /** 原始响应（图片字节）：仍走同一套同源、重定向与错误映射。 */
  async requestRaw(path: string, options: SyncRequestOptions = {}): Promise<Response> {
    const { response, context } = await this.send(path, options);
    if (!response.ok) throw await this.failure(response, context);
    return response;
  }

  private async send(
    path: string,
    options: SyncRequestOptions,
  ): Promise<{ response: Response; context: SyncHttpContext | null }> {
    const context = options.anonymous ? null : await this.options.context();
    const origin = await this.resolveOrigin(context);
    if (!origin) throw new SyncHttpError(401, 'UNAUTHORIZED', '设备尚未绑定家庭');
    const url = new URL(path, origin);
    if (url.origin !== new URL(origin).origin || !url.pathname.startsWith('/api/')) {
      throw new SyncHttpError(400, 'VALIDATION_ERROR', `非法同步请求路径：${path}`);
    }

    const headers = new Headers(options.headers ?? {});
    if (context) {
      headers.set('authorization', `Bearer ${context.token}`);
      headers.set(HOUSEHOLD_EPOCH_HEADER, String(options.epoch ?? context.epoch));
    }

    let response: Response;
    try {
      response = await this.fetchImpl(url.href, {
        method: options.method ?? 'GET',
        body: options.body,
        headers,
        redirect: 'manual',
        credentials: 'omit',
        cache: 'no-store',
      });
    } catch (error) {
      throw new SyncNetworkError('同步请求失败：网络不可用', error);
    }

    // 3xx 一律视为不可信：既不能跟随到其他源，也不能把重定向当成成功。
    if (
      response.redirected ||
      (response.url && new URL(response.url).origin !== url.origin) ||
      response.type === 'opaqueredirect' ||
      (response.status >= 300 && response.status < 400)
    ) {
      throw new SyncNetworkError('同步请求被重定向，已拒绝跨源跟随');
    }
    return { response, context };
  }

  private async failure(
    response: Response,
    context: SyncHttpContext | null,
  ): Promise<SyncHttpError> {
    const body = (await readJson(response)) as ErrorBody;
    const code = typeof body?.code === 'string' ? body.code : `HTTP_${response.status}`;

    if (response.status === 403 && code === 'MEMBER_REVOKED') {
      await this.assertTrustedRevocation(context, body, 'http');
      // assertTrustedRevocation 已抛出可信撤权错误；不可信证据按普通失败返回。
      throw new SyncHttpError(403, code, '成员权限已移除（证据不可信，已忽略）', body);
    }
    if (response.status === 409 && code === 'EPOCH_MISMATCH') {
      const currentEpoch = Number(body.currentEpoch);
      if (!Number.isSafeInteger(currentEpoch) || currentEpoch < 0) {
        throw new SyncHttpError(409, code, '账本代际不匹配（缺少 currentEpoch）', body);
      }
      throw new EpochMismatchError(currentEpoch);
    }
    if (response.status === 429) throw new RateLimitedError(retryAfterMs(response, body));
    throw new SyncHttpError(response.status, code, `同步请求失败：${code}`, body);
  }

  /**
   * 校验撤权证据并调用注入的 onRevoked。证据不可信时静默返回，由调用方按普通失败处理。
   */
  async assertTrustedRevocation(
    captured: SyncHttpContext | null,
    body: ErrorBody,
    source: 'http' | 'websocket',
  ): Promise<void> {
    if (!captured) return;
    if (typeof body.householdId !== 'string' || typeof body.memberId !== 'string') return;
    if (body.householdId !== captured.householdId || body.memberId !== captured.memberId) return;

    // 请求发起后可能已经换绑；必须重新读取当前最新代际，旧代际迟到响应零副作用。
    const latest = await this.options.context();
    if (!latest) return;
    if (
      latest.generation !== captured.generation ||
      latest.cloudOrigin !== captured.cloudOrigin ||
      latest.householdId !== captured.householdId ||
      latest.memberId !== captured.memberId
    ) {
      return;
    }

    await this.options.onRevoked?.({
      householdId: captured.householdId,
      memberId: captured.memberId,
      generation: captured.generation,
      source,
    });
    throw new TrustedRevocationError(captured.householdId, captured.memberId, captured.generation);
  }
}

export function createSyncHttpClient(options: SyncHttpClientOptions): SyncHttpClient {
  return new SyncHttpClient(options);
}

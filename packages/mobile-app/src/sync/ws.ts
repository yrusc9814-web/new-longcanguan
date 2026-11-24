/**
 * 同步 WebSocket 客户端：票据 → 连接 → 首帧 `SYNC_CONNECTED` → 帧分发 + 指数退避重连。
 *
 * 安全语义：
 * - 连接建立前捕获 `bindingGeneration` 与家庭/成员身份，迟到帧或旧代际的
 *   `MEMBER_REVOKED` 一律不触发清退；
 * - 仅来自当前绑定的撤权帧触发清退。仅收到 4003 时重新请求票据确认身份。
 * - 普通断开使用指数退避重连。
 */
import type { CloudServerFrame } from '@dafan/shared/sync';

import type { RevocationEvidence, SyncHttpClient, SyncHttpContext } from './http';

export interface SocketLike {
  readonly readyState: number;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type SocketFactory = (url: string) => SocketLike;

const CONNECTING = 0;
const OPEN = 1;

export interface SyncSocketOptions {
  readonly http: SyncHttpClient;
  /** 由绑定上下文生成 ws(s):// 地址；传入 ticket。 */
  readonly url: (context: SyncHttpContext, ticket: string) => string;
  readonly socketFactory?: SocketFactory;
  readonly onAvailable?: (frame: { epoch: number; seq: number }) => void;
  readonly onEpochReset?: (epoch: number) => void;
  readonly onRevoked?: (evidence: RevocationEvidence) => void | Promise<void>;
  readonly onConnected?: (connectionId: string) => void;
  readonly onDisconnected?: () => void;
  readonly onError?: (error: unknown) => void;
  readonly timers?: Timers;
  readonly now?: () => number;
}

export interface Timers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const defaultTimers: Timers = {
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

function defaultSocketFactory(url: string): SocketLike {
  const Ctor = (globalThis as { WebSocket?: new (url: string) => SocketLike }).WebSocket;
  if (!Ctor) throw new Error('当前环境不支持 WebSocket');
  return new Ctor(url);
}

export class SyncSocket {
  private socket: SocketLike | null = null;
  private stopped = false;
  private timer: unknown = null;
  private attempt = 0;
  private requestingTicket = false;
  connectionId: string | null = null;

  constructor(private readonly options: SyncSocketOptions) {}

  get connected(): boolean {
    return this.socket?.readyState === OPEN;
  }

  async connect(): Promise<void> {
    if (
      this.stopped ||
      this.requestingTicket ||
      this.timer !== null ||
      this.socket?.readyState === CONNECTING ||
      this.connected
    )
      return;
    this.requestingTicket = true;
    try {
      await this.open();
    } finally {
      this.requestingTicket = false;
    }
  }

  private async open(): Promise<void> {
    const context = await this.options.http.context();
    if (!context || this.stopped) return;
    // 捕获代际：帧到达时用它判定是否仍属同一绑定。
    const captured: SyncHttpContext = context;

    let ticket: string;
    try {
      const response = (await this.options.http.request('/api/sync/ws-ticket', {
        method: 'POST',
      })) as { ticket?: unknown };
      if (typeof response?.ticket !== 'string') throw new Error('ws-ticket 响应无效');
      ticket = response.ticket;
    } catch (error) {
      this.options.onError?.(error);
      this.scheduleReconnect();
      return;
    }

    if (this.stopped) return;
    let socket: SocketLike;
    try {
      socket = (this.options.socketFactory ?? defaultSocketFactory)(
        this.options.url(captured, ticket),
      );
    } catch (error) {
      this.options.onError?.(error);
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    socket.onmessage = (event) => {
      if (this.socket === socket) void this.onFrame(captured, event.data);
    };
    socket.onerror = (error) => this.options.onError?.(error);
    socket.onclose = (event) => {
      if (this.socket === socket) this.onClose(event);
    };
  }

  private async onFrame(captured: SyncHttpContext, data: unknown): Promise<void> {
    let frame: CloudServerFrame | null = null;
    try {
      frame = typeof data === 'string' ? (JSON.parse(data) as CloudServerFrame) : null;
    } catch {
      return;
    }
    if (!frame || typeof frame !== 'object') return;

    switch (frame.type) {
      case 'SYNC_CONNECTED':
        this.attempt = 0;
        this.connectionId = frame.connectionId;
        this.options.onConnected?.(frame.connectionId);
        return;
      case 'SYNC_AVAILABLE':
        this.options.onAvailable?.({ epoch: frame.epoch, seq: frame.seq });
        return;
      case 'EPOCH_RESET':
        this.options.onEpochReset?.(frame.epoch);
        return;
      case 'MEMBER_REVOKED':
        try {
          await this.options.http.assertTrustedRevocation(captured, frame, 'websocket');
        } catch {
          this.stop();
        }
        return;
      default:
        return;
    }
  }

  private onClose(event: { code?: number }): void {
    this.socket = null;
    this.connectionId = null;
    this.options.onDisconnected?.();
    if (this.stopped) return;
    // A close code carries no member identity. Reconnect to confirm revocation over HTTP.
    if (event.code === 4003) void this.connect();
    else this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    const timers = this.options.timers ?? defaultTimers;
    const backoff = Math.min(30_000, 1_000 * 2 ** Math.min(this.attempt, 5));
    this.attempt += 1;
    this.timer = timers.setTimeout(() => {
      this.timer = null;
      if (this.stopped) return;
      void this.connect();
    }, backoff);
  }

  /** 立即重连（前台恢复/网络恢复）。 */
  retryNow(): void {
    if (
      this.stopped ||
      this.requestingTicket ||
      this.socket?.readyState === CONNECTING ||
      this.connected
    )
      return;
    const timers = this.options.timers ?? defaultTimers;
    if (this.timer !== null) {
      timers.clearTimeout(this.timer);
      this.timer = null;
    }
    this.attempt = 0;
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    const timers = this.options.timers ?? defaultTimers;
    if (this.timer !== null) {
      timers.clearTimeout(this.timer);
      this.timer = null;
    }
    const socket = this.socket;
    this.socket = null;
    this.connectionId = null;
    try {
      socket?.close(1000, 'CLIENT_STOP');
    } catch {
      // 已关闭的连接重复 close 无副作用。
    }
  }
}

export function createSyncSocket(options: SyncSocketOptions): SyncSocket {
  return new SyncSocket(options);
}

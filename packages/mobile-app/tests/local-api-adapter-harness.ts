import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';

/**
 * 在 Node vm 中执行真实的 public/google2-adapter.js。
 *
 * 适配器末尾的 boot() 依赖完整页面 DOM，这里把 readyState 固定为 'loading'，
 * 让脚本只注册 DOMContentLoaded 监听而不启动界面逻辑；随后直接取用脚本导出的
 * window.DafanApiClient，从而验证生产请求/重试逻辑本身。
 */

export const ADAPTER_PATH = resolve(import.meta.dirname, '..', 'public', 'google2-adapter.js');

/** 与适配器一致的 PIN 存储键，用于预置/读取解锁凭证。 */
export const ADAPTER_PIN_KEY = 'dafan_google2_pin_token';

export interface AdapterApiError extends Error {
  status: number;
  code: string;
  details?: Record<string, unknown>;
  retryAfter?: number;
}

export interface AdapterApiClient {
  request<T = unknown>(path: string, options?: Record<string, unknown>): Promise<T>;
  requestBlob(path: string, options?: Record<string, unknown>): Promise<Blob>;
  get<T = unknown>(path: string): Promise<T>;
  post<T = unknown>(path: string, body?: unknown): Promise<T>;
  put<T = unknown>(path: string, body?: unknown): Promise<T>;
  delete<T = unknown>(path: string, body?: unknown): Promise<T>;
  ApiError: new (...args: never[]) => AdapterApiError;
}

export interface AdapterHarness {
  readonly api: AdapterApiClient;
  readonly window: Record<string, unknown>;
  readonly storage: Map<string, string>;
}

export interface AdapterHarnessOptions {
  readonly fetch: typeof fetch;
  readonly origin?: string;
}

export function loadGoogle2Adapter(options: AdapterHarnessOptions): AdapterHarness {
  const source = readFileSync(ADAPTER_PATH, 'utf8');
  const origin = options.origin ?? 'http://localhost';

  const storage = new Map<string, string>();
  const localStorage = {
    getItem: (key: string) => (storage.has(key) ? (storage.get(key) as string) : null),
    setItem: (key: string, value: string) => {
      storage.set(key, String(value));
    },
    removeItem: (key: string) => {
      storage.delete(key);
    },
  };

  const documentStub = {
    readyState: 'loading',
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => ({ style: {}, classList: { add() {}, remove() {} }, appendChild() {} }),
    body: null,
    head: null,
    documentElement: null,
  };

  const windowStub: Record<string, unknown> = { location: { origin } };
  const context: Record<string, unknown> = {
    window: windowStub,
    document: documentStub,
    localStorage,
    fetch: options.fetch,
    location: windowStub.location,
    console,
    URL,
    URLSearchParams,
    Request,
    Response,
    Headers,
    FormData,
    Blob,
    File,
    AbortController,
    JSON,
    Math,
    Date,
    Promise,
    Error,
    TypeError,
    Number,
    String,
    Boolean,
    Object,
    Array,
    Map,
    Set,
    RegExp,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
  };

  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'google2-adapter.js' });

  const api = windowStub.DafanApiClient as AdapterApiClient | undefined;
  if (!api) throw new Error('adapter 未导出 DafanApiClient');

  return { api, window: windowStub, storage };
}

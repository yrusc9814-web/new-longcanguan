/**
 * 真实 `workerd`（Miniflare）测试脚手架。
 *
 * 目的：让 vitest 用**真实** Cloudflare 运行时执行 Worker 入口，而不是 Node 里的
 * `cloudflare:workers` shim。链路为：
 *
 *   调用者给定的入口（TS 源码 URL） --esbuild--> 单个 ESM bundle
 *     --> 系统 ASCII 临时目录 --> Miniflare(spawn workerd) --> dispatchFetch
 *
 * 约束与设计要点：
 * - `vitest` 固定在 4.1.12，不降级；本文件不依赖 `@cloudflare/vitest-pool-workers`。
 * - 工作区位于 `D:\Vanta-pro\搭饭` 这类非 ASCII 路径，`workerd` 与持久化目录可能
 *   对此敏感，因此 bundle、Miniflare 持久化目录全部落在系统 ASCII 临时目录，
 *   `dispose()` 时整体 `rm -rf`。
 * - `HOUSEHOLD_HUB` / `PRIVATE_BUCKET` / `compatibility_date` 从 `wrangler.toml`
 *   读取，避免脚手架与生产配置漂移；DO 以 SQLite 类注册。
 * - harness 暴露真实的 `Miniflare` 实例与 `dispatchFetch`，便于测试自行访问
 *   DO namespace / R2 bucket 并断言持久化状态。
 */

import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import type {
  DurableObjectNamespace,
  DurableObjectStub,
  R2Bucket,
} from '@cloudflare/workers-types';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';

/** Miniflare 的 `dispatchFetch` 形态（与 workers 的 fetch 语义一致）。 */
export type WorkerdDispatchFetch = (
  input: Request | string,
  init?: RequestInit,
) => Promise<Response>;

/**
 * 定长 body 的字节数；流式 body 返回 `undefined`。
 *
 * 真实浏览器/原生客户端上传定长 body 时会带 `Content-Length`，而 Miniflare 的
 * `dispatchFetch` 内部用 `new Request(input, init)` 转发 `Uint8Array` 时会变成
 * `transfer-encoding: chunked`。Worker 里 `request.headers.get('content-length')`
 * 因此是 `null`，与线上行为不一致。harness 在这里补齐，保持与真实请求一致。
 */
function fixedBodyLength(body: BodyInit | null | undefined): number | undefined {
  if (body == null || typeof body === 'string') {
    return body == null ? undefined : new TextEncoder().encode(body).byteLength;
  }
  if (body instanceof Uint8Array) {
    return body.byteLength;
  }
  if (body instanceof ArrayBuffer) {
    return body.byteLength;
  }
  if (ArrayBuffer.isView(body)) {
    return body.byteLength;
  }
  if (typeof Blob !== 'undefined' && body instanceof Blob) {
    return body.size;
  }
  return undefined;
}

export interface WorkerdWorkerConfig {
  /** `wrangler.toml` 的 compatibility_date，与生产保持一致。 */
  compatibilityDate: string;
  /** Durable Object 绑定名，例如 `HOUSEHOLD_HUB`。 */
  durableObjectBinding: string;
  /** Durable Object 类名，例如 `HouseholdHub`。 */
  durableObjectClass: string;
  /** R2 绑定名，例如 `PRIVATE_BUCKET`。 */
  r2Binding: string;
}

export interface StartWorkerdOptions {
  /**
   * 额外的 Worker 绑定（等同于 wrangler 的 `[vars]` / `wrangler secret`）。
   * 用于把 `OWNER_BOOTSTRAP_SECRET` 这类部署期密钥注入真实 workerd。
   */
  bindings?: Record<string, string>;
  /** 显式指定 Durable Object 实例名，默认 `default`（与生产单例一致）。 */
  durableObjectName?: string;
}

export interface WorkerdHarness {
  /** 真实的 Miniflare 实例，保留给需要直接访问设施的测试。 */
  readonly mf: Miniflare;
  /** Miniflare 的 `dispatchFetch`，请求进入真实 workerd。 */
  readonly dispatchFetch: WorkerdDispatchFetch;
  /** 本次运行的入口文件 URL。 */
  readonly entry: URL;
  /** 生成的 ESM bundle 路径（ASCII 临时目录内）。 */
  readonly bundlePath: string;
  /** 本次运行的 ASCII 临时根目录。 */
  readonly tempDir: string;
  /** 持久化目录（ASCII 临时目录内）。 */
  readonly persistPath: string;
  /** 与 `wrangler.toml` 对齐的绑定信息。 */
  readonly config: WorkerdWorkerConfig;
  /** 单例 Durable Object 名（默认 `default`）。 */
  readonly durableObjectName: string;
  /** 取 Durable Object namespace（底层为真实 workerd）。 */
  getDurableObjectNamespace(): Promise<DurableObjectNamespace>;
  /** 取 R2 bucket（底层为真实 workerd）。 */
  getR2Bucket(): Promise<R2Bucket>;
  /**
   * 强制按 Cloudflare 的 hibernate 语义驱逐当前 DO 实例。
   *
   * 这不是“模拟”：它由 Miniflare 的 dev control 通道直接作用于运行中的
   * workerd 隔离区，实例内字段丢失、下一次请求重建对象，而 WebSocket 与其
   * `serializeAttachment` 载荷继续存活。用于验证 Hibernation API 的恢复路径。
   */
  evictDurableObject(): Promise<void>;
  /** 建一个指向单例 DO 的 stub（用于断言活跃 socket 数量等内部状态）。 */
  getStub(): Promise<DurableObjectStub>;
  /** 停止 workerd 并删除临时目录；可重复调用。 */
  dispose(): Promise<void>;
}

const ASCII_ONLY = /^[\x20-\x7e]+$/;

const BUNDLE_FILE = 'worker.mjs';
const PERSIST_DIR = 'state';

interface WorkerdBinary {
  path: string;
  version: string;
  /** workerd 支持的最新 compatibility date（`YYYY-MM-DD`）。 */
  compatibilityDate: string;
}

/**
 * 解析 `workerd` 二进制。
 *
 * Miniflare 4 当前固定依赖 `workerd@1.20260730.1`，其支持的最新 compatibility
 * date 是 `2026-08-06`，低于 `wrangler.toml` 的 `2026-11-01`，直接启动会报
 * "newest date supported by this server binary"。因此本包把 `workerd` 作为独立
 * devDependency 固定到与生产对齐的版本，并通过 Miniflare 唯一支持的
 * `MINIFLARE_WORKERD_PATH` 钩子注入。
 *
 * 若调用者已自行设置 `MINIFLARE_WORKERD_PATH`，则完全尊重调用者选择。
 */
function resolveWorkerdBinary(): WorkerdBinary | undefined {
  try {
    const require = createRequire(import.meta.url);
    const runtime = require('workerd') as {
      default?: string;
      version?: string;
      compatibilityDate?: string;
    };
    if (typeof runtime.default !== 'string') {
      return undefined;
    }
    const { version = 'unknown', compatibilityDate = 'unknown' } = runtime;
    return { path: runtime.default, version, compatibilityDate };
  } catch {
    return undefined;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * `MINIFLARE_WORKERD_PATH` 是进程级全局变量。多个测试文件并行启动 harness 时，
 * 用引用计数保证：第一个 harness 设置、最后一个释放，且只在值仍是我们写入时清理，
 * 不覆盖调用者自行设置的值。
 */
let installedWorkerdPath: string | undefined;
let activeHarnesses = 0;

function acquireWorkerdPath(path: string): void {
  if (process.env.MINIFLARE_WORKERD_PATH === undefined) {
    process.env.MINIFLARE_WORKERD_PATH = path;
    installedWorkerdPath = path;
  }
  activeHarnesses += 1;
}

function releaseWorkerdPath(): void {
  activeHarnesses = Math.max(0, activeHarnesses - 1);
  if (activeHarnesses > 0) {
    return;
  }
  if (
    installedWorkerdPath !== undefined &&
    process.env.MINIFLARE_WORKERD_PATH === installedWorkerdPath
  ) {
    delete process.env.MINIFLARE_WORKERD_PATH;
  }
  installedWorkerdPath = undefined;
}

/**
 * 选出系统级、纯 ASCII、且真实存在的临时目录作为根。
 *
 * `workerd` 在非 ASCII 路径下可能出现 spawn/日志/cache 相关异常，因此即使
 * 调用者在中文路径下运行测试，也必须落到 ASCII 目录。
 */
async function resolveAsciiTempBase(): Promise<string> {
  const candidates = [process.env.TEMP, process.env.TMP, tmpdir(), 'C:\\Windows\\Temp', '/tmp'];
  for (const candidate of candidates) {
    if (!candidate || !isAbsolute(candidate) || !ASCII_ONLY.test(candidate)) {
      continue;
    }
    if (await isDirectory(candidate)) {
      return candidate;
    }
  }
  throw new Error(
    'startWorkerd: 找不到可用的纯 ASCII 系统临时目录（已尝试 TEMP/TMP/tmpdir/C:\\Windows\\Temp//tmp）。',
  );
}

/**
 * 从 `wrangler.toml` 读取生产配置，避免测试与部署参数各写一份。
 *
 * 只做最小 TOML 解析：按键值行 + 区块头（`[[...]]` / `[...]`）跟踪当前区块，
 * 不引入 TOML 依赖。
 */
export async function readWorkerConfig(): Promise<WorkerdWorkerConfig> {
  const configUrl = new URL('../wrangler.toml', import.meta.url);
  const text = await readFile(fileURLToPath(configUrl.href), 'utf8');

  const blocks = new Map<string, Map<string, string>>();
  let current = '';
  blocks.set(current, new Map());

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (line === '') {
      continue;
    }
    const section = /^\[\[?([^\]]+)\]\]?$/.exec(line);
    if (section) {
      current = section[1].trim();
      if (!blocks.has(current)) {
        blocks.set(current, new Map());
      }
      continue;
    }
    const entry = /^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/.exec(line);
    if (entry) {
      blocks.get(current)?.set(entry[1], entry[2].replace(/^"(.*)"$/, '$1'));
    }
  }

  const compatibilityDate = blocks.get('')?.get('compatibility_date');

  let durableObjectBinding: string | undefined;
  let durableObjectClass: string | undefined;
  let r2Binding: string | undefined;
  for (const [name, values] of blocks) {
    if (name.startsWith('durable_objects.bindings')) {
      durableObjectBinding ??= values.get('name');
      durableObjectClass ??= values.get('class_name');
    } else if (name.startsWith('r2_buckets')) {
      r2Binding ??= values.get('binding');
    }
  }

  if (!compatibilityDate || !durableObjectBinding || !durableObjectClass || !r2Binding) {
    throw new Error(
      `startWorkerd: 无法从 ${configUrl.pathname} 解析 compatibility_date / DO 绑定 / R2 绑定。`,
    );
  }

  return {
    compatibilityDate,
    durableObjectBinding,
    durableObjectClass,
    r2Binding,
  };
}

/**
 * 启动真实 workerd。
 *
 * @param entry 测试入口的 `file:` URL（TS 源码即可，内部用 esbuild 打包）。
 */
export async function startWorkerd(
  entry: URL,
  options: StartWorkerdOptions = {},
): Promise<WorkerdHarness> {
  if (entry.protocol !== 'file:') {
    throw new Error(`startWorkerd: 入口必须是 file: URL，收到 ${entry.protocol}`);
  }

  const entryPath = fileURLToPath(entry.href);
  if (!(await stat(entryPath).then((s) => s.isFile()))) {
    throw new Error(`startWorkerd: 入口文件不存在 ${entryPath}`);
  }

  const config = await readWorkerConfig();
  const durableObjectName = options.durableObjectName ?? 'default';
  const workerd = resolveWorkerdBinary();
  if (!workerd) {
    throw new Error(
      'startWorkerd: 无法解析 `workerd` 二进制。请确认 @dafan/cloud-worker 的 devDependency `workerd` 已安装。',
    );
  }
  if (
    /^\d{4}-\d{2}-\d{2}$/.test(workerd.compatibilityDate) &&
    workerd.compatibilityDate < config.compatibilityDate
  ) {
    throw new Error(
      `startWorkerd: workerd ${workerd.version} 支持的最新 compatibility date 是 ${workerd.compatibilityDate}，` +
        `低于 wrangler.toml 的 ${config.compatibilityDate}。请升级 workerd 或下调生产 compatibility_date。`,
    );
  }

  const tempBase = await resolveAsciiTempBase();
  const tempDir = await mkdtemp(join(tempBase, 'dcw-'));
  const bundlePath = join(tempDir, BUNDLE_FILE);
  const persistPath = join(tempDir, PERSIST_DIR);

  // Miniflare 只提供 `MINIFLARE_WORKERD_PATH` 这一条注入路径；用引用计数管理。
  acquireWorkerdPath(workerd.path);

  let mf: Miniflare | undefined;
  let disposed = false;

  const dispose = async (): Promise<void> => {
    if (disposed) {
      return;
    }
    disposed = true;
    try {
      await mf?.dispose();
    } finally {
      releaseWorkerdPath();
      // Windows 上 workerd 句柄释放可能滞后：失败时重试而不是让整轮测试挂掉。
      await rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  };

  try {
    await build({
      entryPoints: [entryPath],
      outfile: bundlePath,
      bundle: true,
      format: 'esm',
      target: 'es2022',
      platform: 'neutral',
      conditions: ['workerd', 'worker', 'browser'],
      // `cloudflare:workers` 只有 workerd 能解析，交给运行时处理。
      external: ['cloudflare:workers'],
      logLevel: 'silent',
      sourcemap: false,
    });

    mf = new Miniflare({
      modules: true,
      scriptPath: bundlePath,
      modulesRoot: tempDir,
      compatibilityDate: config.compatibilityDate,
      durableObjects: {
        [config.durableObjectBinding]: {
          className: config.durableObjectClass,
          useSQLite: true,
        },
      },
      r2Buckets: [config.r2Binding],
      // 生产密钥经 wrangler secret 注入；测试用 bindings 走同一条 vars 通道。
      bindings: { HOUSEHOLD_DO_NAME: durableObjectName, ...(options.bindings ?? {}) },
      // 持久化数据也落在 ASCII 临时目录，dispose 时清理。
      defaultPersistRoot: persistPath,
      logRequests: false,
      telemetry: { enabled: false },
    });

    await mf.ready;

    const instance = mf;
    // Miniflare 自带 undici 类型，与本包 `@cloudflare/workers-types` 的全局类型
    // 在 Headers/URL 迭代器上不完全兼容；此处仅做边界断言，运行期都是同一种对象。
    const dispatchFetch: WorkerdDispatchFetch = async (input, init) => {
      let forwardedInit = init;
      const length = fixedBodyLength(init?.body);
      if (length !== undefined) {
        const headers = new Headers(init?.headers);
        if (!headers.has('content-length')) {
          headers.set('content-length', String(length));
          forwardedInit = { ...init, headers };
        }
      }
      return (await instance.dispatchFetch(
        input as never,
        forwardedInit as never,
      )) as unknown as Response;
    };

    return {
      mf: instance,
      dispatchFetch,
      entry,
      bundlePath,
      tempDir,
      persistPath,
      config,
      durableObjectName,
      getDurableObjectNamespace: () =>
        instance.getDurableObjectNamespace(
          config.durableObjectBinding,
        ) as unknown as Promise<DurableObjectNamespace>,
      getR2Bucket: () => instance.getR2Bucket(config.r2Binding) as unknown as Promise<R2Bucket>,
      evictDurableObject: () =>
        instance.unsafeEvictDurableObject('', config.durableObjectClass, {
          name: durableObjectName,
          webSockets: 'hibernate',
        }),
      getStub: async () => {
        const namespace = await instance.getDurableObjectNamespace(config.durableObjectBinding);
        return (namespace as unknown as DurableObjectNamespace).get(
          (namespace as unknown as DurableObjectNamespace).idFromName(durableObjectName),
        ) as unknown as DurableObjectStub;
      },
      dispose,
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}

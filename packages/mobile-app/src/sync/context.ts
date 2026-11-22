/**
 * 绑定上下文提供者：把 SQLite 绑定行 + Keystore 令牌 + 本机 epoch 汇成一次快照。
 *
 * 每次 HTTP/WS 请求发起时都重新读取，从而得到"请求发起时代际"；
 * 响应返回后再读一次最新代际，用于丢弃旧代际迟到结果。
 */
import type { AppSecurityBridge } from '../native/app-security.js';
import type { DatabaseClient } from '../db/database.js';
import { readBinding, readSyncState } from './ledger.js';
import type { SyncHttpContext } from './http';

export interface ContextProviderOptions {
  readonly getDatabase: () => Promise<DatabaseClient>;
  readonly security: Pick<AppSecurityBridge, 'getMemberToken'>;
}

export async function readSyncContext(
  options: ContextProviderOptions,
): Promise<SyncHttpContext | null> {
  const database = await options.getDatabase();
  const [binding, state, token] = await Promise.all([
    readBinding(database),
    readSyncState(database),
    options.security.getMemberToken(),
  ]);
  if (!binding || !token.memberToken) return null;
  return {
    cloudOrigin: binding.cloudOrigin,
    householdId: binding.householdId,
    memberId: binding.memberId,
    role: binding.role,
    generation: binding.generation,
    epoch: state.epoch,
    token: token.memberToken,
  };
}

export function createContextProvider(options: ContextProviderOptions) {
  return () => readSyncContext(options);
}

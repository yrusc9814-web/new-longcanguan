/** 可绑定到 SQLite 的参数值。布尔值在驱动层归一为 1/0。 */
export type SqlValue = null | number | string | boolean;

export interface RunResult {
  readonly changes: number;
  readonly lastInsertRowid: number;
}

/**
 * 最小 SQL 驱动契约。
 *
 * 约束：
 * - `query` 只接收只读语句（SELECT / WITH / PRAGMA / EXPLAIN），返回行对象数组；
 * - `run` 接收单条写语句 + 绑定参数，不隐式开启事务；
 * - `exec` 接收原始 SQL（可含多条语句），不隐式开启事务。
 *
 * 事务完全由上层的 `Database.withWriteTransaction` 控制，驱动本身绝不自行 BEGIN/COMMIT。
 */
export interface SqlDriver {
  /** 驱动标识，用于日志与测试断言。 */
  readonly kind: string;
  query<T>(sql: string, values?: readonly SqlValue[]): Promise<T[]>;
  run(sql: string, values?: readonly SqlValue[]): Promise<RunResult>;
  exec(sql: string): Promise<void>;
  /** 关闭连接；未打开的驱动可不实现。 */
  close?(): Promise<void>;
}

/** 只读语句判定：按首关键字识别，避免把写语句误送 query。 */
export function isReadStatement(sql: string): boolean {
  const text = sql.trimStart();
  const head = text.split(/[\s(]+/, 1)[0]?.toUpperCase() ?? '';
  if (head === 'PRAGMA') {
    // `PRAGMA x = y` 会改库，只能走事务里的 exec/run；去掉引号内容后再找 `=`。
    return !text.replace(/"[^"]*"|'[^']*'/g, '').includes('=');
  }
  return head === 'SELECT' || head === 'WITH' || head === 'EXPLAIN';
}

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
 * - `query` 返回行对象数组。业务入口只允许 SELECT、VALUES 及白名单内的只读 PRAGMA；
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

const READ_PRAGMAS = new Set([
  'APPLICATION_ID',
  'COMPILE_OPTIONS',
  'DATABASE_LIST',
  'FOREIGN_KEYS',
  'JOURNAL_MODE',
  'PAGE_COUNT',
  'QUERY_ONLY',
  'SCHEMA_VERSION',
  'USER_VERSION',
]);

const INSPECTION_PRAGMAS = new Set([
  'FOREIGN_KEY_CHECK',
  'FOREIGN_KEY_LIST',
  'INDEX_INFO',
  'INDEX_LIST',
  'INDEX_XINFO',
  'INTEGRITY_CHECK',
  'QUICK_CHECK',
  'TABLE_INFO',
  'TABLE_LIST',
  'TABLE_XINFO',
]);

/** 跳过一个 SQLite 括号组，返回下一 token 的位置。 */
function afterGroup(tokens: readonly string[], start: number): number {
  if (tokens[start] !== '(') return -1;
  let depth = 1;
  for (let i = start + 1; i < tokens.length; i += 1) {
    if (tokens[i] === '(') depth += 1;
    if (tokens[i] === ')') depth -= 1;
    if (depth === 0) return i + 1;
  }
  return -1;
}

/** WITH 可以引导读写语句，需检查定义之后的语句类型。 */
function afterCommonTableExpressions(tokens: readonly string[], start: number): number {
  let i = start + 1;
  if (tokens[i] === 'RECURSIVE') i += 1;
  do {
    i += 1; // CTE 名称。
    if (tokens[i] === '(') i = afterGroup(tokens, i);
    if (tokens[i] !== 'AS') return -1;
    i += 1;
    if (tokens[i] === 'NOT' && tokens[i + 1] === 'MATERIALIZED') i += 1;
    if (tokens[i] === 'MATERIALIZED') i += 1;
    i = afterGroup(tokens, i);
    if (i < 0 || tokens[i] !== ',') return i;
    i += 1;
  } while (i < tokens.length);
  return -1;
}

/** 只放行一条可读取结果的 SQL。SQLite 负责校验其余语法。 */
export function isReadStatement(sql: string): boolean {
  // 将字符串、引用标识符和注释视为整体，避免把其中的括号或分号视为语法。
  const tokens = (
    sql.match(
      /--[^\n]*|\/\*[\s\S]*?(?:\*\/|$)|'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]|[\w$\u0080-\uFFFF]+|[^ \t\r\n\v\f]/g,
    ) ?? []
  )
    .filter((token) => !token.startsWith('--') && !token.startsWith('/*'))
    .map((token) => token.toUpperCase());
  if (tokens.at(-1) === ';') tokens.pop();
  if (tokens.includes(';')) return false;

  let i = 0;
  if (tokens[i] === 'EXPLAIN') {
    i += 1;
    if (tokens[i] === 'QUERY' && tokens[i + 1] === 'PLAN') i += 2;
  }
  if (tokens[i] === 'WITH') i = afterCommonTableExpressions(tokens, i);
  if (tokens[i] === 'SELECT' || tokens[i] === 'VALUES') return true;
  if (tokens[i] !== 'PRAGMA') return false;

  const nameIndex = tokens[i + 2] === '.' ? i + 3 : i + 1;
  const name = tokens[nameIndex]?.replace(/^["'`[]|["'`\]]$/g, '') ?? '';
  const argument = nameIndex + 1;
  // EXPLAIN 也可能在准备语句时执行 PRAGMA，且括号形式同样可用于赋值。
  if (argument === tokens.length) return READ_PRAGMAS.has(name) || INSPECTION_PRAGMAS.has(name);
  return INSPECTION_PRAGMAS.has(name) && afterGroup(tokens, argument) === tokens.length;
}

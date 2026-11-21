import type { InventoryChangeType, QuantityUnit } from '../types/index.js';

/**
 * 食材同步载荷的确定性事实描述。
 *
 * 所有 `id` 均为客户端已真实写入 SQLite 的主键：重放方直接按载荷中的 ID 复用，
 * 不得再次随机生成，否则同一次业务操作在双端会得到不同主键。
 */

/** 新建批次与对应库存日志的落库主键对。 */
export interface IngredientBatchRefPayload {
  readonly batchId: string;
  readonly logId: string;
}

/** 活批次的完整落库事实。 */
export interface IngredientBatchFactPayload {
  readonly id: string;
  readonly ingredientId: string;
  readonly quantity: number;
  readonly unit: QuantityUnit;
  readonly purchaseDate: string | null;
  readonly expiryDate: string | null;
  readonly location: string | null;
  readonly opened: boolean;
  readonly consumePriority: boolean;
  readonly notes: string | null;
  readonly version: number;
  readonly deletedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** 库存日志的完整落库事实（含库存外键与前后数量）。 */
export interface IngredientInventoryLogFactPayload {
  readonly id: string;
  readonly ingredientId: string | null;
  readonly ingredientNameSnapshot: string;
  readonly inventoryBatchId: string | null;
  readonly beforeQuantity: number;
  readonly changeQuantity: number;
  readonly afterQuantity: number;
  readonly unit: QuantityUnit;
  readonly changeType: InventoryChangeType;
  readonly relatedPlanId: string | null;
  readonly relatedRecordId: string | null;
  readonly notes: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** 创建食材的 upsert 载荷：食材 + 活批次 + 本次初始库存日志。 */
export type IngredientUpsertPayload = {
  readonly id: string;
  readonly name: string;
  readonly imagePath: string | null;
  readonly category: string | null;
  readonly quantity: number;
  readonly unit: QuantityUnit;
  readonly purchaseDate: string | null;
  readonly expiryDate: string | null;
  readonly location: string | null;
  readonly minStock: number | null;
  readonly maxStock: number | null;
  readonly opened: boolean;
  readonly notes: string | null;
  readonly version: number;
  readonly deletedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly batches: readonly IngredientBatchFactPayload[];
  readonly inventoryLogs: readonly IngredientInventoryLogFactPayload[];
};

/** 编辑命令保留的标准化请求（与上游 PUT 语义一致）。 */
export interface IngredientUpdateRequestPayload {
  readonly name: string;
  readonly imagePath?: string | null;
  readonly category?: string | null;
  readonly unit: QuantityUnit;
  readonly minStock?: number | null;
  readonly maxStock?: number | null;
  readonly notes?: string | null;
  readonly batches?: readonly {
    readonly quantity: number;
    readonly unit: QuantityUnit;
    readonly purchaseDate?: string | null;
    readonly expiryDate?: string | null;
    readonly location?: string | null;
    readonly opened?: boolean;
    readonly consumePriority?: boolean;
    readonly notes?: string | null;
  }[];
  readonly quantity?: number | null;
  readonly purchaseDate?: string | null;
  readonly expiryDate?: string | null;
  readonly location?: string | null;
  readonly opened?: boolean;
}

/**
 * 编辑命令载荷。
 *
 * `implicitBatch` / `replacedBatches` / `addedBatch` 记录本次写入真实产生的
 * 批次与日志主键；重放方按这些 ID 落库即可复现同一事实，无需再次查询猜测。
 */
export type IngredientUpdateCommandPayload = {
  readonly id: string;
  readonly baseVersion: number;
  /** 与本次业务写入相同的服务端时间（ISO 字符串）。 */
  readonly executedAt: string;
  readonly request: IngredientUpdateRequestPayload;
  readonly implicitBatch?: IngredientBatchRefPayload;
  /** 显式 batches 替换时按请求顺序排列。 */
  readonly replacedBatches?: readonly IngredientBatchRefPayload[];
  /** 数量差额补建的新批次。 */
  readonly addedBatch?: IngredientBatchRefPayload;
  /** 数量差额扣减时按实际扣减顺序记录。 */
  readonly deductions?: readonly IngredientDeductionPayload[];
};

/** 聚合消耗保留的标准化请求。 */
export interface IngredientConsumeRequestPayload {
  readonly mode: 'QUANTITY' | 'ALL';
  readonly quantity?: number;
  readonly unit?: QuantityUnit;
  readonly ingredientVersion: number;
  readonly notes: string | null;
}

/** 单次扣减的实际批次/日志事实，按扣减顺序排列。 */
export interface IngredientDeductionPayload extends IngredientBatchRefPayload {
  readonly beforeQuantity: number;
  readonly changeQuantity: number;
  readonly afterQuantity: number;
  readonly unit: QuantityUnit;
}

/** 消耗命令载荷。 */
export type IngredientConsumeCommandPayload = {
  readonly id: string;
  readonly baseVersion: number;
  /** 与本次业务写入相同的服务端时间（ISO 字符串）。 */
  readonly executedAt: string;
  readonly request: IngredientConsumeRequestPayload;
  readonly implicitBatch?: IngredientBatchRefPayload;
  readonly deductions: readonly IngredientDeductionPayload[];
  /** 兼容既有消费方：与 deductions 的 logId 顺序一致。 */
  readonly inventoryLogIds: readonly string[];
};

/** 删除命令只保留软删时间。 */
export type IngredientDeletePayload = {
  readonly deletedAt: string;
};

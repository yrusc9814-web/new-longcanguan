/**
 * 购物清单同步契约（T-004 / D5 收敛与入库）。
 *
 * 确定性铁律：端侧写入 `sync_outbox` 的载荷必须完整固化本次本地事务真实落库的
 * 主键与业务时间，云端重放逐行复用这些 ID，不得再次随机生成。
 */
import type { QuantityUnit, ShoppingListStatus, ShoppingSourceType } from '../types/index.js';

/** 端云预置的默认活跃购物清单 ID，初始版本为 1。 */
export const SHOPPING_DEFAULT_LIST_ID = 'shopping_list_active_default';

export const SHOPPING_DEFAULT_LIST_NAME = '购物清单';

/**
 * 真正可用于结构化写回的标准单位（与 Google2 适配器一致，不含 `OTHER` 伪映射）。
 * 含「少许」等无结构化数量的条目在入库时整单 422。
 */
export const STANDARD_SHOPPING_UNITS = [
  'GRAM',
  'KILOGRAM',
  'MILLILITER',
  'LITER',
  'PIECE',
  'BOX',
  'BAG',
  'BOTTLE',
  'CAN',
  'PACK',
  'PORTION',
] as const;

export type StandardShoppingUnit = (typeof STANDARD_SHOPPING_UNITS)[number];

/** 新增同步命令类型：勾选买完与冰箱入库在同一个本地事务内完成。 */
export const SHOPPING_CHECKIN_COMMAND = 'SHOPPING_CHECKIN' as const;

/** 入库请求的标准化快照（itemIds 已去重排序，作为幂等哈希的输入）。 */
export interface ShoppingCheckinRequestPayload {
  readonly shoppingListId: string;
  readonly baseVersion: number;
  readonly operationId: string;
  readonly itemIds: readonly string[];
}

/** 入库并移除前的条目快照，包含重放所需的采购数据。 */
export interface ShoppingCheckinItemFactPayload {
  readonly id: string;
  readonly ingredientId: string | null;
  readonly ingredientNameSnapshot: string;
  readonly quantity: number | null;
  readonly unit: QuantityUnit | null;
  readonly amountText: string | null;
  readonly category: string | null;
  readonly sourceType: ShoppingSourceType;
  readonly sourceId: string | null;
  readonly completed: boolean;
  readonly sortOrder: number;
  readonly notes: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** 入库产生的食材 / 批次 / 库存日志事实，主键均取自本次真实写入。 */
export interface ShoppingCheckinInventoryFactPayload {
  /**
   * `LEGACY_HEAL`：历史存量食材入库前补建的等效批次（ADJUST）；
   * `INGREDIENT_IMPORT`：本次采购真正新增的 PURCHASE 批次。
   */
  readonly kind: 'LEGACY_HEAL' | 'INGREDIENT_IMPORT';
  /** 本次是否新建食材行（false 表示复用既有食材并累加）。 */
  readonly createdIngredient: boolean;
  readonly ingredientId: string;
  readonly ingredientNameSnapshot: string;
  readonly ingredientUnit: QuantityUnit;
  /** 入库后食材汇总数量（基础单位）。 */
  readonly ingredientQuantity: number;
  /** 入库前的食材版本；新建食材为 null（版本链起点）。 */
  readonly ingredientBaseVersion: number | null;
  /** 入库后食材版本；首次新建保持 1。 */
  readonly ingredientVersion: number;
  /** 入库后食材的标准化分类（7 大分类之一）。 */
  readonly ingredientCategory: string | null;
  readonly batchId: string;
  readonly batchQuantity: number;
  readonly batchUnit: QuantityUnit;
  readonly logId: string;
  readonly beforeQuantity: number;
  readonly afterQuantity: number;
  readonly executedAt: string;
}

/** `ShoppingCheckinOperation` 幂等行的完整事实。 */
export interface ShoppingCheckinOperationFactPayload {
  readonly id: string;
  readonly shoppingListId: string;
  /** 入库请求（清单 + itemIds）的 SHA-256，用于区分同 ID 不同内容。 */
  readonly payloadHash: string;
  readonly resultJson: string;
  readonly createdAt: string;
}

/** `SHOPPING_CHECKIN` 命令载荷。 */
export interface ShoppingCheckinCommandPayload {
  readonly shoppingListId: string;
  readonly baseVersion: number;
  /** 与本次本地事务写入相同的业务时间。 */
  readonly executedAt: string;
  /** 事务提交后的清单版本。 */
  readonly listVersion: number;
  /** 写入采购批次的本地日历日期。 */
  readonly purchaseDate: string;
  readonly request: ShoppingCheckinRequestPayload;
  readonly items: readonly ShoppingCheckinItemFactPayload[];
  readonly inventory: readonly ShoppingCheckinInventoryFactPayload[];
  readonly operation: ShoppingCheckinOperationFactPayload;
}

/** 清单条目同步事实（完整列，供重放直接落库）。 */
export interface ShoppingListItemFactPayload {
  readonly id: string;
  readonly shoppingListId: string;
  readonly ingredientId: string | null;
  readonly ingredientNameSnapshot: string;
  readonly quantity: number | null;
  readonly unit: QuantityUnit | null;
  readonly amountText: string | null;
  readonly category: string | null;
  readonly sourceType: ShoppingSourceType;
  readonly sourceId: string | null;
  readonly completed: boolean;
  readonly sortOrder: number;
  readonly notes: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** 清单 upsert 聚合载荷：清单行 + 全部存活条目，重放后逐列一致。 */
export interface ShoppingListUpsertPayload {
  readonly id: string;
  readonly name: string;
  readonly status: ShoppingListStatus;
  readonly notes: string | null;
  readonly version: number;
  readonly deletedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly items: readonly ShoppingListItemFactPayload[];
  /** 本次本地写入前的条目快照，供云端逐项合并。旧客户端可省略。 */
  readonly baseItems?: readonly ShoppingListItemFactPayload[];
}

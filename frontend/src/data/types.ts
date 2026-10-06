/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

// 字段级取数状态：
// - failed：取数失败（通信/传感器等），留空显示「暂无」，给出原因，retryable 时给重试入口
// - empty：实测本身为空（如备用管路未装流量计），留空显示「暂无」，说明原因，不提供重试
// - overlimit：实测值取到了，但与限值冲突；按实测优先保留实测值，只附越限说明
export type FieldIssueKind = 'failed' | 'empty' | 'overlimit'

export type FieldIssue = {
  kind: FieldIssueKind
  reason: string
  attempts?: number
  retryable?: boolean
}

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  /** 停运标记：终态，与异常分开计；复运时回落 */
  stopped?: boolean
  /** 复运幂等标记：同一系统重复复运只回落一次、只生成一条联动清污任务 */
  resumed?: boolean
  /** 备件单库存周期内领用幂等标记：办理验收后重置 */
  consumed?: boolean
  /** 字段级取数说明，键为业务字段名 */
  fieldIssues?: Record<string, FieldIssue>
  [field: string]: unknown
}

// 概览卡片指标的计算规则：页面、概览、导出都按这套规则算，避免各算各的。
export type MetricRule =
  | { kind: 'countStatus'; label: string; status: string }
  | { kind: 'sum'; label: string; field: string }
  | { kind: 'avg'; label: string; field: string }
  | { kind: 'max'; label: string; field: string }
  | { kind: 'last'; label: string; field: string }
  | { kind: 'countFilled'; label: string; field: string }
  | { kind: 'expiring'; label: string; field: string; days: number }
  | { kind: 'custom'; label: string; name: 'cleaningTotal' }

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  /** 动作只在这些状态下展示；未登记的动作按「到达目标状态后隐藏」的通用规则处理 */
  actionStatuses?: Record<string, string[]>
  /** 哪些状态算异常态：异常量统一按状态判定，不再按动作名猜 */
  abnormalStatuses: string[]
  metrics: MetricRule[]
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
  /** 不阻断流程的提示（取数失败已留空、越限按实测登记、联动任务等） */
  warning?: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number; stopped: number }[]
}

// 值班清污台账（事件流水，清污条数的唯一口径）
export type DutyTaskStatus = '待清理' | '清理中' | '已完成'

export type DutyTask = {
  id: number
  idemKey: string
  kind: 'cooling-resume' | 'trashrack-clean'
  refId: number
  refCode: string
  rackCode: string
  unit: string
  title: string
  status: DutyTaskStatus
  createdAt: string
  completedAt?: string
  measuredPressure?: number | null
}

export type DutyLedger = {
  tasks: DutyTask[]
  seq: number
}

export type Database = {
  version: number
  entries: Record<string, EntryRow[]>
  duty: DutyLedger
}

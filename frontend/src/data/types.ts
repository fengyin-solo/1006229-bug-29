/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
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
  /** 提交检查时取数不成功的字段（取数失败 / 暂无数据），用于页面逐条说明，而不是笼统报错。 */
  warnings?: ReadingWarning[]
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}

/** 量测取数的三种结果：取到实测值 / 测点无数值（空）/ 取数失败。后两种必须留空并说明原因。 */
export type ReadingState = 'ok' | 'empty' | 'failed'

/** 取值来源优先级：在线实测 > 人工补录 > 台账迁移值；限值只用于判定越限，绝不反写实测值。 */
export type ReadingSource = 'online' | 'manual' | 'legacy'

export type Reading = {
  key: string
  module: string
  id: number
  field: string
  state: ReadingState
  value: number | null
  /** empty/failed 时的人话说明，例如「流量计通信中断」或「测点未采集到有效数值」。 */
  reason: string
  source: ReadingSource
  /** 取值依据：两边取值冲突时为什么按这一份算，写清楚给值班员看。 */
  basis: string
  at: string
  /** 已尝试取数次数，第一次失败、重试成功用它演示重试入口。 */
  attempts: number
}

export type ReadingWarning = {
  field: string
  state: ReadingState
  reason: string
}

/** 拦污栅清污台账：历史底数（迁移自老台账）+ 复运后新增的清理事件，跨页面读同一份。 */
export type CleaningEvent = {
  rackId: number
  unit: string
  at: string
  source: 'trashrack' | 'cooling'
  seeded?: boolean
}

export type CleaningLedger = {
  /** 每个栅体迁移过来的历史清污条数底数，按原编号保留。 */
  base: Record<number, number>
  events: CleaningEvent[]
}

/** 本地持久化信封：行数据、量测读数、清污台账、动作幂等令牌收在同一个 localStorage 键里。 */
export type Envelope = {
  schemaVersion: number
  rows: Record<string, EntryRow[]>
  readings: Record<string, Reading>
  cleaning: CleaningLedger
  /** 已落账的终态动作令牌，保证「重复复运只回落一次 / 重复提交只记一次数量」。 */
  tokens: Record<string, string>
}

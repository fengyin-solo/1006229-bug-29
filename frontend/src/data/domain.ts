import type { Reading, ReadingSource, ReadingState } from './types'

// 限值口径：限值只用来判越限、驱动状态/告警，绝不把实测值往限值上改。
// 实测与限值冲突时一律以实测为准（见 resolveAgainstLimit）。
export type MeasureSpec = {
  label: string
  unit: string
  decimals: number
  // 越限上/下限，取不到（null）表示该量不按限值判。
  high?: number
  low?: number
}

const COOLING_FIELDS: Record<string, MeasureSpec> = {
  供水压力: { label: '供水压力', unit: 'MPa', decimals: 2, high: 0.5, low: 0.3 },
  供水流量: { label: '供水流量', unit: 'm³/s', decimals: 2, high: 40, low: 20 },
  水温数值: { label: '水温', unit: '℃', decimals: 1, high: 32 },
  滤水器压差: { label: '滤水器压差', unit: 'MPa', decimals: 2, high: 0.15 },
}

const TRASHRACK_FIELDS: Record<string, MeasureSpec> = {
  前后压差: { label: '前后压差', unit: 'MPa', decimals: 2, high: 0.3 },
}

export function measureSpec(module: string, field: string): MeasureSpec | null {
  if (module === 'cooling') return COOLING_FIELDS[field] ?? null
  if (module === 'trashrack') return TRASHRACK_FIELDS[field] ?? null
  return null
}

export const COOLING_MEASURE_FIELDS = Object.keys(COOLING_FIELDS)
export const TRASHRACK_MEASURE_FIELDS = Object.keys(TRASHRACK_FIELDS)

export function readingKey(module: string, id: number, field: string): string {
  return `${module}:${id}:${field}`
}

// 两边取值冲突时的取值优先级，也是页面/导出里写清的依据：
// 在线实测(online) > 人工补录(manual) > 台账迁移值(legacy)。
// 同来源再比采集时间，取更新的一份。限值不参与“取哪份值”，只决定越限标记。
const SOURCE_RANK: Record<ReadingSource, number> = { online: 3, manual: 2, legacy: 1 }
export const SOURCE_LABEL: Record<ReadingSource, string> = {
  online: '在线实测',
  manual: '人工补录',
  legacy: '台账迁移',
}

export function pickReading(a: Reading, b: Reading): Reading {
  if (SOURCE_RANK[a.source] !== SOURCE_RANK[b.source]) {
    return SOURCE_RANK[a.source] > SOURCE_RANK[b.source] ? a : b
  }
  return a.at >= b.at ? a : b
}

/** 实测与限值冲突时的统一口径：保留实测值，仅返回是否越限与说明，不夹逼、不置零。 */
export function resolveAgainstLimit(reading: Reading): { value: number | null; overLimit: boolean; note: string } {
  const spec = measureSpec(reading.module, reading.field)
  if (reading.state !== 'ok' || reading.value === null || !spec) {
    return { value: reading.value, overLimit: false, note: reading.basis }
  }
  const high = spec.high
  const low = spec.low
  const overHigh = high !== undefined && reading.value > high
  const overLow = low !== undefined && reading.value < low
  if (overHigh || overLow) {
    const side = overHigh ? '高于上限' : '低于下限'
    const bound = overHigh ? high : low
    return {
      value: reading.value,
      overLimit: true,
      note: `实测 ${reading.value}${spec.unit} ${side} ${bound}${spec.unit}，按实测值为准并标记越限，不回改限值`,
    }
  }
  return { value: reading.value, overLimit: false, note: reading.basis }
}

// 早期把“取不到”写成 0 的识别规则（规则由实现方定，这里固化并在页面说明）：
// 1) 该字段是有量测限值的量（压力/流量/压差），0 本身落在越限区间，物理上不该与“运行正常”并存；
// 2) 检查日期早于换型/取数改造的分界日 2026-08-01（早期记录）；
// 3) 同一行没有任何对应的失败说明（真正为 0 的停运/断水行另有记录）。
// 三条同时满足判为“早期取数失败误记 0”，迁移成取数失败、留空并要求重新取数；
// 真正测得的 0（如已停运系统断水）不满足第 2 条/有停机事实，保留 0。
export const ZERO_BACKFILL_CUTOFF = '2026-08-01'

export function isSuspectLegacyZero(
  module: string,
  field: string,
  value: number,
  checkDate: string,
  status: string,
): boolean {
  const spec = measureSpec(module, field)
  if (!spec || value !== 0) return false
  if (!(checkDate && checkDate < ZERO_BACKFILL_CUTOFF)) return false
  // 已停运/已关闭等停机态下 0 是真实物理值，不算误记。
  if (status.includes('停运') || status.includes('关闭') || status.includes('退出')) return false
  return true
}

type TeleOutcome = { state: ReadingState; value: number | null; reason: string; failUntilAttempts: number }

// 纯前端没有真实测点：用确定性脚本模拟“取数”。attempts 已试次数，到阈值后失败翻成功，
// 用来演示“第一次取不到 → 给重试入口 → 重试取到”。
const SCRIPTED: Record<string, TeleOutcome> = {
  // 待检查系统第一次提交：流量计通信中断，重试一次后取到。
  [readingKey('cooling', 1, '供水流量')]: {
    state: 'failed',
    value: null,
    reason: '供水流量计通信中断（RTU 无应答）',
    failUntilAttempts: 1,
  },
  // 运行中系统测点长期未采集到有效数值：这是“数据本身为空”，与取数失败区分。
  [readingKey('cooling', 2, '供水流量')]: {
    state: 'empty',
    value: null,
    reason: '流量计本周期未采集到有效数值（测点无数值，非取数失败）',
    failUntilAttempts: 0,
  },
}

const TELE_VALUE: Record<string, number> = {
  [readingKey('cooling', 1, '供水压力')]: 0.42,
  [readingKey('cooling', 1, '水温数值')]: 24.8,
  [readingKey('cooling', 1, '滤水器压差')]: 0.06,
  [readingKey('cooling', 1, '供水流量')]: 33.6,
  [readingKey('cooling', 2, '供水流量')]: 30.5,
  // 早期误记为 0 的 COOL-0005，重新取数能取到真实流量，演示“按规则回填”。
  [readingKey('cooling', 5, '供水流量')]: 29.8,
}

export type TelemetryResult = {
  state: ReadingState
  value: number | null
  reason: string
}

export function readTelemetry(module: string, id: number, field: string, attempts: number): TelemetryResult {
  const key = readingKey(module, id, field)
  const scripted = SCRIPTED[key]
  if (scripted) {
    if (scripted.state === 'empty') {
      return { state: 'empty', value: null, reason: scripted.reason }
    }
    if (attempts <= scripted.failUntilAttempts) {
      return { state: 'failed', value: null, reason: scripted.reason }
    }
    return { state: 'ok', value: TELE_VALUE[key] ?? 0, reason: '' }
  }
  if (key in TELE_VALUE) {
    return { state: 'ok', value: TELE_VALUE[key], reason: '' }
  }
  // 没有埋点的量：取在线表当前值，取不到就报取数失败（而不是默默给 0）。
  return { state: 'failed', value: null, reason: `${field}测点暂未接入取数通道` }
}

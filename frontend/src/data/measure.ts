import type { FieldIssue } from './types'

// 现场表计取数服务（纯前端模拟，换回后端时换成实测接口即可）。
// 关键约定：
// 1. 实测值优先：返回的 measured 就是登记口径，限值 limit 只用于越限判定，绝不拿限值替换实测值。
// 2. 取不到数与数据本身为空是两回事：
//    - error 可重试（通信超时等）→ kind=failed, retryable=true，留空，给重试入口
//    - error 不可重试（传感器故障/备用管路无表计）→ failed/empty，留空，只说明原因
//    - value 为 null 且无 error → 现场实测本身为空（备用管路无水流），暂无数据，不可重试

// 取数通道上线日：早于此日且被记成 0/占位符的读数，视为早期「取不到数误记 0」。
export const METER_ONLINE_DATE = '2026-09-03'

export type MeasureField = '供水压力' | '供水流量' | '水温数值' | '滤水器压差' | '前后压差'

export type MeasureOutcome = {
  value: number | null
  issue?: FieldIssue
}

type Scenario = {
  value: number | null
  limit?: number
  error?: { reason: string; retryable: boolean; transient?: boolean }
  note?: string
}

// 各测点的确定性剧本，键为 `${系统编号|栅体编号}:${字段}`。
// 找不到剧本时按编号生成稳定的正常实测值，保证普通记录都能取到数。
const SCENARIOS: Record<string, Scenario> = {
  // COOL-0004 运行中：流量表通信超时，重试后成功（验证重试入口）
  'COOL-0004:供水流量': {
    value: 0.32,
    error: { reason: '流量表通信超时，未取到实测数据', retryable: true, transient: true },
  },
  // COOL-0005 备用技术供水管：流量计未投运，实测为空，非取数失败
  'COOL-0005:供水流量': {
    value: null,
    note: '备用管路未投运，管内无水流，现场表计读数为空',
  },
  // COOL-0006 早期传感器故障，永久取不到，留空
  'COOL-0006:供水流量': {
    value: null,
    error: { reason: '流量传感器故障，测点无信号，需检修后补测', retryable: false },
  },
  'COOL-0006:供水压力': {
    value: null,
    error: { reason: '压力变送器与故障流量测点共回路，同样无信号', retryable: false },
  },
  // COOL-0007 滤水器实测压差越限：实测优先，保留实测值并附越限说明
  'COOL-0007:滤水器压差': { value: 0.092, limit: 0.08 },
  // COOL-0008 早期「误记 0」：重新取数直接取回真实值（按检查日期回填）
  'COOL-0008:供水流量': { value: 0.29 },
  'COOL-0008:供水压力': { value: 0.3 },
  // COOL-0009 已停运：复运时重新取数，恢复正常口径
  'COOL-0009:供水流量': { value: 0.27 },
  'COOL-0009:供水压力': { value: 0.31 },
}

export const FIELD_LIMITS: Record<string, Partial<Record<MeasureField, number>>> = {
  cooling: {
    供水压力: 0.45,
    供水流量: 0.4,
    水温数值: 40,
    滤水器压差: 0.08,
  },
  trashrack: {
    前后压差: 0.3,
  },
}

function hash(code: string): number {
  let h = 0
  for (let i = 0; i < code.length; i += 1) {
    h = (h * 31 + code.charCodeAt(i)) >>> 0
  }
  return h
}

function fallbackValue(code: string, field: MeasureField): number {
  const h = hash(`${code}:${field}`)
  switch (field) {
    case '供水压力':
      return Math.round((0.28 + (h % 12) / 100) * 1000) / 1000
    case '供水流量':
      return Math.round((0.24 + (h % 10) / 100) * 1000) / 1000
    case '水温数值':
      return Math.round((24 + (h % 8)) * 10) / 10
    case '滤水器压差':
      return Math.round((0.04 + (h % 25) / 1000) * 1000) / 1000
    case '前后压差':
      return Math.round((0.08 + (h % 15) / 100) * 1000) / 1000
    default:
      return 0
  }
}

/**
 * 现场取数。
 * @param code 系统编号/栅体编号
 * @param field 测点字段
 * @param attempt 第几次尝试，从 1 开始；瞬态故障在第 2 次成功
 */
export function measure(code: string, field: MeasureField, attempt = 1): MeasureOutcome {
  const scenario = SCENARIOS[`${code}:${field}`]
  if (!scenario) {
    return { value: fallbackValue(code, field) }
  }
  if (scenario.error) {
    const stillFailing = scenario.error.transient ? attempt < 2 : true
    if (stillFailing) {
      return {
        value: null,
        issue: {
          kind: 'failed',
          reason: scenario.error.reason,
          attempts: attempt,
          retryable: scenario.error.retryable,
        },
      }
    }
    // 瞬态故障重试成功：按实测值登记，不再挂字段问题（重试过程由动作提示说明）
    return { value: scenario.value }
  }
  if (scenario.value === null) {
    return {
      value: null,
      issue: { kind: 'empty', reason: scenario.note ?? '现场实测为空，暂无数据' },
    }
  }
  const limit = scenario.limit
  if (typeof limit === 'number' && scenario.value > limit) {
    return {
      value: scenario.value,
      issue: {
        kind: 'overlimit',
        reason: `实测值 ${scenario.value} 超过限值 ${limit}，按实测优先口径登记，请安排检查`,
      },
    }
  }
  return { value: scenario.value }
}

/** 早期把取不到的数写成 0 的识别规则（规则口径集中在此，供迁移与文档共用）。 */
export function isLegacyFalseZero(date: string, value: unknown): boolean {
  if (typeof value === 'number') {
    return value === 0 && date < METER_ONLINE_DATE
  }
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed === '0') {
      return date < METER_ONLINE_DATE
    }
    // 示例占位文本（非数值）同样视为通道未上线时的无效读数
    return trimmed !== '' && Number.isNaN(Number(trimmed)) && date < METER_ONLINE_DATE
  }
  return false
}

export function measureLimit(moduleKey: string, field: MeasureField): number | undefined {
  return FIELD_LIMITS[moduleKey]?.[field]
}

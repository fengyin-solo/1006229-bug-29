import { useDataVersion } from './bus'
import { measureSpec, readingKey, resolveAgainstLimit } from './domain'
import { allRows, getCleaning, getReading, listRows } from './local-store'
import type { EntryRow, Reading } from './types'

// 派生选择器：列表 / 概览 / 导出 / 值班清单都只从这里读数，保证四处口径一致。
// 每个选择器先 touch 数据版本，写操作 bump 后所有页面跟着重算。
function touch(): void {
  useDataVersion()
}

export type DisplayValue = {
  raw: string | number | boolean
  text: string
  unit: string
  isMeasure: boolean
  state: Reading['state'] | 'text'
  reason: string
  basis: string
  overLimit: boolean
  source: Reading['source'] | ''
}

export function displayValue(module: string, row: EntryRow, field: string): DisplayValue {
  touch()
  const spec = measureSpec(module, field)
  const raw = row[field] ?? ''
  if (!spec) {
    return {
      raw,
      text: raw === '' || raw === null || raw === undefined ? '—' : String(raw),
      unit: '',
      isMeasure: false,
      state: 'text',
      reason: '',
      basis: '',
      overLimit: false,
      source: '',
    }
  }
  const reading = getReading(module, Number(row.id), field)
  if (!reading) {
    return {
      raw,
      text: '暂无',
      unit: spec.unit,
      isMeasure: true,
      state: 'empty',
      reason: `${field}尚未取数，暂无数据`,
      basis: '',
      overLimit: false,
      source: '',
    }
  }
  const resolved = resolveAgainstLimit(reading)
  if (reading.state === 'failed') {
    return {
      raw,
      text: '取数失败',
      unit: spec.unit,
      isMeasure: true,
      state: 'failed',
      reason: reading.reason,
      basis: reading.basis,
      overLimit: false,
      source: reading.source,
    }
  }
  if (reading.state === 'empty' || resolved.value === null) {
    return {
      raw,
      text: '暂无',
      unit: spec.unit,
      isMeasure: true,
      state: 'empty',
      reason: reading.reason,
      basis: reading.basis,
      overLimit: false,
      source: reading.source,
    }
  }
  return {
    raw,
    text: resolved.value.toFixed(spec.decimals),
    unit: spec.unit,
    isMeasure: true,
    state: 'ok',
    reason: resolved.note,
    basis: reading.basis,
    overLimit: resolved.overLimit,
    source: reading.source,
  }
}

// 异常口径：技术供水按状态「异常」计异常系统数；「已停运」单列。复运后状态回运行中，两处一起回落。
export function isCoolingAbnormal(row: EntryRow): boolean {
  touch()
  return String(row.status) === '异常'
}

export function coolingStats(rows: EntryRow[]) {
  touch()
  return {
    running: rows.filter((r) => String(r.status) === '运行中').length,
    abnormal: rows.filter((r) => String(r.status) === '异常').length,
    pending: rows.filter((r) => String(r.status) === '待检查').length,
    stopped: rows.filter((r) => String(r.status) === '已停运').length,
  }
}

// 一条技术供水是否有取数层面的待办（失败/空值），供列表标记与值班清单联动。
export type ReadingAlert = { field: string; state: 'failed' | 'empty'; reason: string }

export function moduleReadingAlerts(module: string, rows: EntryRow[], fields: string[]) {
  touch()
  return rows
    .map((row) => {
      const problems: ReadingAlert[] = fields
        .map((field) => ({ field, view: displayValue(module, row, field) }))
        .filter((item) => item.view.state === 'failed' || item.view.state === 'empty')
        .map((item) => ({
          field: item.field,
          state: item.view.state as 'failed' | 'empty',
          reason: item.view.reason,
        }))
      return { row, problems }
    })
    .filter((item) => item.problems.length > 0)
}

export function trashrackStats(rows: EntryRow[]) {
  touch()
  return {
    waiting: rows.filter((r) => ['待清理', '清理中'].includes(String(r.status))).length,
    cleaned: rows.filter((r) => String(r.status) === '已清理').length,
    damaged: rows.filter((r) => String(r.status) === '已损坏').length,
  }
}

export function maxTrashrackPressure(rows: EntryRow[]): number | null {
  touch()
  let max: number | null = null
  for (const row of rows) {
    const v = displayValue('trashrack', row, '前后压差')
    if (v.state === 'ok') {
      const n = Number(v.text)
      if (max === null || n > max) max = n
    }
  }
  return max
}

// —— 清污台账：历史底数（迁移）+ 复运后新增事件，跨页面总数相同 ——
export function rackCleaningCount(rackId: number): number {
  touch()
  const ledger = getCleaning()
  const added = ledger.events.filter((e) => e.rackId === rackId && !e.seeded).length
  return (ledger.base[rackId] ?? 0) + added
}

export function totalCleaningCount(): number {
  touch()
  const ledger = getCleaning()
  const baseSum = Object.values(ledger.base).reduce((s, n) => s + n, 0)
  const added = ledger.events.filter((e) => !e.seeded).length
  return baseSum + added
}

export function unitCleaningCount(unit: string): number {
  touch()
  const racks = listRows('trashrack').filter((r) => String(r['所属机组']) === unit)
  return racks.reduce((sum, r) => sum + rackCleaningCount(Number(r.id)), 0)
}

// 各模块异常量：技术供水用状态口径，其余沿用 abnormal 标记。
export function moduleAbnormalCount(key: string, rows: EntryRow[]): number {
  touch()
  if (key === 'cooling') return rows.filter(isCoolingAbnormal).length
  return rows.filter((r) => r.abnormal).length
}

export function overviewRows() {
  touch()
  return allRows()
}

export function findRow(module: string, id: number): EntryRow | undefined {
  touch()
  return listRows(module).find((r) => Number(r.id) === id)
}

export function readingOf(module: string, id: number, field: string) {
  touch()
  return getReading(module, id, field)
}

export { readingKey }

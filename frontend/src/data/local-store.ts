import { bumpDataVersion } from './bus'
import {
  COOLING_MEASURE_FIELDS,
  TRASHRACK_MEASURE_FIELDS,
  isSuspectLegacyZero,
  measureSpec,
  readingKey,
} from './domain'
import { SEED_ROWS } from './seed'
import type { CleaningLedger, Envelope, EntryRow, Reading } from './types'

// 本地持久化：行数据 + 量测读数 + 清污台账 + 动作令牌收在同一个 localStorage 键里，
// 列表、概览、导出、值班清单读到的是同一份。
const STORAGE_KEY = 'hydropower-plant-om:entries'
export const SCHEMA_VERSION = 2

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return Number(value)
  }
  return null
}

// 从既有行数据迁移量测读数：有限数值按在线实测迁入；命中“早期误记 0”规则的改记为取数失败并留空；
// 空串/占位文本记为暂无（空）。这样老数据进来就和新口径一致。
function migrateReading(
  module: string,
  row: EntryRow,
  field: string,
): Reading | null {
  const spec = measureSpec(module, field)
  if (!spec) return null
  const id = Number(row.id)
  const key = readingKey(module, id, field)
  const checkDate = String(row['检查日期'] ?? row['清理日期'] ?? '')
  const status = String(row.status ?? '')
  const num = toNumber(row[field])
  const now = checkDate || new Date().toISOString().slice(0, 10)

  if (num !== null) {
    if (isSuspectLegacyZero(module, field, num, checkDate, status)) {
      return {
        key, module, id, field,
        state: 'failed',
        value: null,
        reason: '早期取数失败曾被误记为 0，已按规则留空，需重新取数核实',
        source: 'legacy',
        basis: `检查日期 ${checkDate} 早于分界日且 0 与正常运行状态并存，判为取数失败而非实测 0`,
        at: now,
        attempts: 0,
      }
    }
    return {
      key, module, id, field,
      state: 'ok',
      value: num,
      reason: '',
      source: 'legacy',
      basis: '迁移自既有台账在线测点值，实测为准',
      at: now,
      attempts: 0,
    }
  }

  const raw = String(row[field] ?? '').trim()
  if (raw === '') {
    return {
      key, module, id, field,
      state: 'empty',
      value: null,
      reason: `${field}本周期未采集到有效数值（数据本身为空，不是取数失败）`,
      source: 'legacy',
      basis: '既有台账该格留空，按“暂无数据”保留并说明',
      at: now,
      attempts: 0,
    }
  }
  return {
    key, module, id, field,
    state: 'failed',
    value: null,
    reason: `${field}历史值「${raw}」不是有效数值，需重新取数`,
    source: 'legacy',
    basis: '占位文本无法作为实测值，按取数失败处理',
    at: now,
    attempts: 0,
  }
}

function measureFieldsFor(module: string): string[] {
  if (module === 'cooling') return COOLING_MEASURE_FIELDS
  if (module === 'trashrack') return TRASHRACK_MEASURE_FIELDS
  return []
}

function buildReadings(rowsByModule: Record<string, EntryRow[]>): Record<string, Reading> {
  const out: Record<string, Reading> = {}
  for (const module of ['cooling', 'trashrack']) {
    for (const row of rowsByModule[module] ?? []) {
      for (const field of measureFieldsFor(module)) {
        const reading = migrateReading(module, row, field)
        if (reading) out[reading.key] = reading
      }
    }
  }
  return out
}

function buildCleaning(rowsByModule: Record<string, EntryRow[]>): CleaningLedger {
  const base: Record<number, number> = {}
  for (const row of rowsByModule.trashrack ?? []) {
    const n = toNumber(row['清污次数'])
    if (n !== null) base[Number(row.id)] = n
  }
  return { base, events: [] }
}

function buildEnvelope(rowsByModule: Record<string, EntryRow[]>): Envelope {
  return {
    schemaVersion: SCHEMA_VERSION,
    rows: rowsByModule,
    readings: buildReadings(rowsByModule),
    cleaning: buildCleaning(rowsByModule),
    tokens: {},
  }
}

// 老数据按原有编号迁移：同 id 的行保留（含值班员改过的状态/字段），种子里新增的字段补进来；
// 种子里多出来的编号（缺项）追加到末尾，不覆盖既有编号。全新模块直接用种子。
function mergeRowsByKey(seed: EntryRow[], legacy: EntryRow[]): EntryRow[] {
  const byId = new Map<number, EntryRow>()
  for (const row of seed) byId.set(Number(row.id), clone(row))
  for (const row of legacy) {
    const id = Number(row.id)
    const base = byId.get(id)
    if (base) {
      byId.set(id, { ...base, ...clone(row) })
    } else {
      byId.set(id, clone(row))
    }
  }
  return [...byId.values()].sort((a, b) => Number(a.id) - Number(b.id))
}

function mergeWithSeed(legacy: Record<string, EntryRow[]>): Record<string, EntryRow[]> {
  const merged: Record<string, EntryRow[]> = {}
  for (const key of Object.keys(SEED_ROWS)) {
    merged[key] = mergeRowsByKey(SEED_ROWS[key] ?? [], legacy[key] ?? [])
  }
  for (const key of Object.keys(legacy)) {
    if (!(key in merged)) merged[key] = clone(legacy[key])
  }
  return merged
}

function seedRows(): Record<string, EntryRow[]> {
  return clone(SEED_ROWS)
}

function readStorage(): Envelope {
  const fallback = buildEnvelope(seedRows())
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Envelope | Record<string, EntryRow[]>
    // 已是信封结构：缺的新键补齐，版本旧则重建读数/台账。
    if (parsed && typeof parsed === 'object' && 'schemaVersion' in parsed) {
      const env = parsed as Envelope
      if (env.schemaVersion < SCHEMA_VERSION || !env.readings || !env.cleaning) {
        const rebuilt = buildEnvelope(env.rows ?? seedRows())
        return persist({ ...rebuilt, tokens: env.tokens ?? {} })
      }
      return env
    }
    // 老版本是扁平的「模块 -> 行」：按原编号合并迁移，缺项由种子补进来，读数与清污台账重建。
    const merged = mergeWithSeed(parsed as Record<string, EntryRow[]>)
    return persist(buildEnvelope(merged))
  } catch {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

function persist(envelope: Envelope): Envelope {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(envelope))
  }
  return envelope
}

let cache: Envelope | null = null

export function envelope(): Envelope {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

function commit(next: Envelope): void {
  cache = persist(next)
  bumpDataVersion()
}

export function allRows(): Record<string, EntryRow[]> {
  return envelope().rows
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  commit({ ...envelope(), rows: { ...envelope().rows, [key]: rows } })
}

export function allReadings(): Record<string, Reading> {
  return envelope().readings
}

export function getReading(module: string, id: number, field: string): Reading | undefined {
  return envelope().readings[readingKey(module, id, field)]
}

export function setReading(reading: Reading): void {
  commit({
    ...envelope(),
    readings: { ...envelope().readings, [reading.key]: reading },
  })
}

export function getCleaning(): CleaningLedger {
  return envelope().cleaning
}

export function saveCleaning(cleaning: CleaningLedger): void {
  commit({ ...envelope(), cleaning })
}

export function hasToken(token: string): boolean {
  return Boolean(envelope().tokens[token])
}

export function setToken(token: string): void {
  if (envelope().tokens[token]) return
  commit({ ...envelope(), tokens: { ...envelope().tokens, [token]: new Date().toISOString() } })
}

// 单模块重置：行回到种子，相关量测读数/清污底数也按种子重建，避免跨口径残留。
export function resetRows(key: string): EntryRow[] {
  const freshRows = seedRows()[key] ?? []
  const env = envelope()
  const nextRows = { ...env.rows, [key]: freshRows }
  const readings = { ...env.readings }
  for (const k of Object.keys(readings)) {
    if (k.startsWith(`${key}:`)) delete readings[k]
  }
  Object.assign(readings, buildReadings(nextRows))
  let cleaning = env.cleaning
  if (key === 'trashrack') {
    cleaning = buildCleaning(nextRows)
  }
  const tokens = Object.fromEntries(Object.entries(env.tokens).filter(([t]) => !t.startsWith(`${key}:`)))
  commit({ ...env, rows: nextRows, readings, cleaning, tokens })
  return freshRows
}

export function storageKey(): string {
  return STORAGE_KEY
}

import { MODULE_BY_KEY, MODULES } from './modules'
import { SEED_ROWS } from './seed'
import { isLegacyFalseZero, measure } from './measure'
import type { Database, DutyLedger, EntryRow } from './types'

// 数据迁移与口径规整：
// - 老数据按原有编号保留，种子里新增的记录（缺项）一并补进来。
// - 异常/停运/待办标记统一按状态重算，列表、概览、导出读到同一份。
// - 技术供水早期「取不到数误记 0」按检查日期从早到晚重新取数回填，取不到留空写原因。

export const DB_VERSION = 2

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

export function freshDuty(): DutyLedger {
  return { tasks: [], seq: 0 }
}

export function buildSeedDatabase(): Database {
  const db: Database = { version: DB_VERSION, entries: clone(SEED_ROWS), duty: freshDuty() }
  const normalized = normalizeDatabase(db)
  // 种子里也保留了早期「误记 0」样本，首次播种同样按检查日期重新取数回填。
  refillCoolingLegacy(normalized.entries.cooling ?? [])
  return normalized
}

const COOLING_MEASURE_FIELDS = ['供水压力', '供水流量', '水温数值', '滤水器压差'] as const

function numericFieldsFor(key: string): Set<string> {
  const meta = MODULE_BY_KEY.get(key)
  const fields = new Set<string>()
  meta?.metrics.forEach((rule) => {
    if (rule.kind === 'sum' || rule.kind === 'avg' || rule.kind === 'max' || rule.kind === 'last') {
      fields.add(rule.field)
    }
  })
  if (key === 'cooling') {
    COOLING_MEASURE_FIELDS.forEach((field) => fields.add(field))
  }
  if (key === 'trashrack') {
    fields.add('前后压差')
    fields.add('清污次数')
  }
  if (key === 'spare') {
    fields.add('现有数量')
    fields.add('最低储备量')
  }
  return fields
}

function coerceNumber(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value
  }
  const trimmed = value.trim()
  if (trimmed === '') {
    return value
  }
  const parsed = Number(trimmed)
  return Number.isFinite(parsed) ? parsed : value
}

function recomputeFlags(key: string, row: EntryRow): EntryRow {
  const meta = MODULE_BY_KEY.get(key)
  const status = String(row.status)
  const lastStatus = meta?.statuses[meta.statuses.length - 1]
  return {
    ...row,
    abnormal: meta ? meta.abnormalStatuses.includes(status) : Boolean(row.abnormal),
    pending: status !== lastStatus,
    stopped: status === '已停运' || status === '停运',
  }
}

// 技术供水缺项补齐：所属机组按系统编号回填（COOL-0001..0004 对应 1..4 号机组，其余归公用系统）。
function ensureCoolingUnit(row: EntryRow): EntryRow {
  if (row['所属机组'] !== undefined && String(row['所属机组']).trim() !== '') {
    return row
  }
  const code = String(row['系统编号'] ?? '')
  const matched = /COOL-0*(\d+)/.exec(code)
  const seq = matched ? Number(matched[1]) : 0
  const unit = seq >= 1 && seq <= 4 ? `${seq}号机组` : '公用系统'
  return { ...row, '所属机组': unit }
}

type RefillNote = { code: string; field: string; from: unknown; to: number | null; reason?: string }

// 早期误记 0 的回填：只处理非停运记录，按检查日期从早到晚，逐测点重新取数。
function refillCoolingLegacy(rows: EntryRow[]): RefillNote[] {
  const notes: RefillNote[] = []
  const ordered = rows
    .filter((row) => !row.stopped)
    .slice()
    .sort((a, b) => String(a['检查日期'] ?? '').localeCompare(String(b['检查日期'] ?? '')))
  for (const row of ordered) {
    const date = String(row['检查日期'] ?? '')
    const code = String(row['系统编号'] ?? '')
    for (const field of COOLING_MEASURE_FIELDS) {
      if (!isLegacyFalseZero(date, row[field])) {
        continue
      }
      const outcome = measure(code, field, 1)
      const issues = { ...(row.fieldIssues ?? {}) }
      if (outcome.value === null) {
        row[field] = null
        if (outcome.issue) {
          issues[field] = outcome.issue
        }
      } else {
        row[field] = outcome.value
        delete issues[field]
      }
      row.fieldIssues = issues
      notes.push({ code, field, from: 0, to: outcome.value, reason: outcome.issue?.reason })
    }
  }
  return notes
}

function normalizeModule(key: string, rows: EntryRow[]): EntryRow[] {
  const numericFields = numericFieldsFor(key)
  return rows.map((raw) => {
    let row: EntryRow = { ...raw }
    for (const field of numericFields) {
      if (field in row) {
        row[field] = coerceNumber(row[field])
      }
    }
    if (key === 'cooling') {
      row = ensureCoolingUnit(row)
    }
    return recomputeFlags(key, row)
  })
}

export function normalizeDatabase(db: Database): Database {
  const entries: Record<string, EntryRow[]> = {}
  for (const meta of MODULES) {
    entries[meta.key] = normalizeModule(meta.key, db.entries[meta.key] ?? [])
  }
  return { ...db, entries }
}

// v1 → v2：老数据按原编号保留，新增种子记录（缺项）补入，统一口径，再做早期误记 0 回填。
function migrateV1ToV2(db: Database): { db: Database; refills: RefillNote[] } {
  const entries: Record<string, EntryRow[]> = {}
  for (const meta of MODULES) {
    const stored = db.entries[meta.key] ?? []
    const storedById = new Map(stored.map((row) => [Number(row.id), row]))
    const merged: EntryRow[] = []
    for (const seedRow of SEED_ROWS[meta.key] ?? []) {
      const kept = storedById.get(Number(seedRow.id))
      if (kept) {
        merged.push(kept)
        storedById.delete(Number(seedRow.id))
      } else {
        merged.push(clone(seedRow))
      }
    }
    // 老记录编号不在种子里的，按编号顺序追加，原编号不动。
    merged.push(...storedById.values())
    entries[meta.key] = normalizeModule(meta.key, merged)
  }
  const next: Database = { ...db, version: DB_VERSION, entries, duty: db.duty ?? freshDuty() }
  const refills = refillCoolingLegacy(next.entries.cooling ?? [])
  return { db: next, refills }
}

export function migrateDatabase(raw: unknown): { db: Database; refills: RefillNote[] } {
  // 更早的版本：localStorage 里直接存的是 Record<模块, 行[]>，没有版本壳。
  if (raw && typeof raw === 'object' && !('entries' in raw) && !('version' in raw)) {
    return migrateDatabase({
      version: 1,
      entries: raw as Record<string, EntryRow[]>,
      duty: freshDuty(),
    })
  }
  const db = (raw && typeof raw === 'object' ? clone(raw as Database) : buildSeedDatabase()) as Database
  if (!db.duty) {
    db.duty = freshDuty()
  }
  if (!db.entries) {
    const seed = buildSeedDatabase()
    return { db: seed, refills: [] }
  }
  if ((db.version ?? 1) < DB_VERSION) {
    return migrateV1ToV2(db)
  }
  return { db: normalizeDatabase(db), refills: [] }
}

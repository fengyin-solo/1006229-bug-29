import { buildSeedDatabase, migrateDatabase } from './migrate'
import { SEED_ROWS } from './seed'
import type { Database, DutyLedger, EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都在。
// v2 起带版本壳：{ version, entries, duty }，老版本打开时自动迁移。
const STORAGE_KEY = 'hydropower-plant-om:entries'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

let cache: Database | null = null
let lastRefills: { code: string; field: string; to: number | null; reason?: string }[] = []

function persist(db: Database): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(db))
  }
}

export function refillReport() {
  return lastRefills
}

function readStorage(): Database {
  const fallback = buildSeedDatabase()
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    persist(fallback)
    return fallback
  }
  try {
    const { db, refills } = migrateDatabase(JSON.parse(raw))
    lastRefills = refills
    persist(db)
    return db
  } catch {
    persist(fallback)
    return fallback
  }
}

export function database(): Database {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function allRows(): Record<string, EntryRow[]> {
  return database().entries
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  const db = database()
  const next: Database = { ...db, entries: { ...db.entries, [key]: rows } }
  cache = next
  persist(next)
}

export function dutyLedger(): DutyLedger {
  return database().duty
}

export function saveDuty(duty: DutyLedger): void {
  const db = database()
  const next: Database = { ...db, duty }
  cache = next
  persist(next)
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

// 技术供水与拦污栅共用值班台账：重置任一模块时台账一并回到初始，保证两边清污条数一致。
export function resetModuleData(keys: string[]): void {
  const db = database()
  const entries = { ...db.entries }
  for (const key of keys) {
    entries[key] = clone(SEED_ROWS[key] ?? [])
  }
  const next: Database = { ...db, entries, duty: { tasks: [], seq: 0 } }
  cache = next
  persist(next)
}

export function storageKey(): string {
  return STORAGE_KEY
}

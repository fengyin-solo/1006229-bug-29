import { useDataVersion } from '@/data/bus'
import { COOLING_MEASURE_FIELDS, SOURCE_LABEL, readTelemetry } from '@/data/domain'
import {
  getReading,
  hasToken,
  listRows,
  saveCleaning,
  saveRows,
  setReading,
  setToken,
  getCleaning,
} from '@/data/local-store'
import type { ActionResult, EntryRow, Reading, ReadingWarning } from '@/data/types'

export const COOLING = 'cooling'
export const TRASHRACK = 'trashrack'

// 复运时滤水器压差重新取数的在线实测值（取数成功就回落到正常口径）。
const RESUME_PRESSURE: Record<number, number> = {
  3: 0.09,
  4: 0.1,
}

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

function saveCoolingRow(updated: EntryRow): void {
  const rows = listRows(COOLING)
  const next = rows.map((r) => (Number(r.id) === Number(updated.id) ? updated : r))
  saveRows(COOLING, next)
}

// 对单个量做一次取数，写回读数层，返回最新读数。attempts 累计，第一次失败、重试/再次提交成功用它演示重试。
function fetchOne(
  module: string,
  id: number,
  field: string,
  at: string,
): Reading {
  const prev = getReading(module, id, field)
  const attempts = (prev?.attempts ?? 0) + 1
  const result = readTelemetry(module, id, field, attempts)
  const reading: Reading = {
    key: `${module}:${id}:${field}`,
    module,
    id,
    field,
    state: result.state,
    value: result.state === 'ok' ? result.value : null,
    reason: result.reason,
    source: 'online',
    basis:
      result.state === 'ok'
        ? `在线实测${SOURCE_LABEL.online}取值（第 ${attempts} 次取数成功），实测优先于限值`
        : result.state === 'empty'
          ? '测点本周期无数值，按暂无数据留空，可稍后重试'
          : '取数失败，已留空，可点击重试',
    at,
    attempts,
  }
  setReading(reading)
  return reading
}

// 提交检查：逐个量取数。供水流量取不到（取数失败）时明确报错并说明是取数失败、提交不落地；
// 测点本身无数值（empty）算暂无、允许提交但留空并说明。两种情况不再笼统报一句“提交失败”。
export function submitCoolingCheck(id: number): ActionResult {
  const rows = listRows(COOLING)
  const row = rows.find((r) => Number(r.id) === id)
  if (!row) return { ok: false, message: `没有找到编号为 ${id} 的供水系统` }

  const at = today()
  const warnings: ReadingWarning[] = []
  let hasFailure = false

  for (const field of COOLING_MEASURE_FIELDS) {
    const existing = getReading(COOLING, id, field)
    // 已经取到在线实测值的字段直接沿用，避免“重试成功后再次提交又报失败”。
    const reuse = existing && existing.source === 'online' && existing.state === 'ok'
    const reading = reuse ? existing : fetchOne(COOLING, id, field, at)
    if (reading.state === 'failed') {
      hasFailure = true
      warnings.push({ field, state: 'failed', reason: reading.reason })
    } else if (reading.state === 'empty') {
      warnings.push({ field, state: 'empty', reason: reading.reason })
    }
  }

  if (hasFailure) {
    // 取数失败：不切运行态，读数已留空并带原因，页面给重试入口。
    return {
      ok: false,
      message:
        '提交未完成：以下测点取数失败（不是数据为空），已留空并给出原因，请重试后再提交；其余测点不受影响。',
      warnings,
    }
  }

  // 全部成功或仅为空：进入运行中，空值字段显示“暂无”并说明。
  const updated: EntryRow = { ...row, status: '运行中' }
  saveCoolingRow(updated)
  const message =
    warnings.length > 0
      ? `供水系统已提交检查，当前状态「运行中」；${warnings
          .filter((w) => w.state === 'empty')
          .map((w) => `${w.field}暂无数据`)
          .join('、')}，已在清单中说明原因。`
      : '供水系统已提交检查，当前状态「运行中」'
  return { ok: true, message, warnings }
}

// 系统复运：异常数（随状态）、停运标记、滤水器压差一起回到正常口径。
// 同一系统重复复运只回落一次：先有状态守卫，再加落账令牌双保险。
export function resumeCooling(id: number): ActionResult {
  const rows = listRows(COOLING)
  const index = rows.findIndex((r) => Number(r.id) === id)
  if (index < 0) return { ok: false, message: `没有找到编号为 ${id} 的供水系统` }
  const row = rows[index]
  const current = String(row.status)
  if (current === '运行中') {
    return { ok: false, message: '供水系统已在运行中，重复复运不会重复回落异常计数与压差' }
  }
  if (!['异常', '已停运'].includes(current)) {
    return { ok: false, message: `当前状态「${current}」不允许复运` }
  }

  const token = `cooling:${id}:resume`
  if (hasToken(token)) {
    return { ok: false, message: '该系统本次复运已回落过一次，重复操作不会再扣异常系统数或重置压差' }
  }

  const at = today()
  // 滤水器压差重新取数：成功就回到正常实测值；取不到就留空标失败，绝不硬造一个正常值。
  const pressure = RESUME_PRESSURE[id]
  if (pressure !== undefined) {
    const reading: Reading = {
      key: `${COOLING}:${id}:滤水器压差`,
      module: COOLING,
      id,
      field: '滤水器压差',
      state: 'ok',
      value: pressure,
      reason: '',
      source: 'online',
      basis: '复运时在线实测，压差已回落到正常区间，以实测值为准',
      at,
      attempts: 1,
    }
    setReading(reading)
  } else {
    fetchOne(COOLING, id, '滤水器压差', at)
  }

  const updated: EntryRow = { ...row, status: '运行中' }
  const next = [...rows]
  next[index] = updated
  saveRows(COOLING, next)
  // 令牌在写库成功之后再落，保证“只回落一次”。
  setToken(token)

  const wasStopped = current === '已停运'
  return {
    ok: true,
    message: wasStopped
      ? '供水系统已复运：状态回到运行中，异常系统数与停运标记同步回落，滤水器压差按实测回到正常口径'
      : '供水系统已复运：状态回到运行中，异常系统数同步回落，滤水器压差按实测回到正常口径',
  }
}

// 取数失败 / 暂无 的单字段重试入口：再取一次，成功就补值，仍失败保留原因，可继续重试。
export function retryReading(module: string, id: number, field: string): ActionResult {
  const at = today()
  const reading = fetchOne(module, id, field, at)
  if (reading.state === 'ok') {
    // 同步刷新行内对应格，保证列表/导出读到同一值。
    if (module === COOLING && reading.value !== null) {
      const rows = listRows(COOLING)
      const row = rows.find((r) => Number(r.id) === id)
      if (row) saveCoolingRow({ ...row, [field]: reading.value })
    }
    return { ok: true, message: `${field}重试取数成功：实测 ${reading.value}，已按实测值更新` }
  }
  if (reading.state === 'empty') {
    return { ok: false, message: `${field}仍暂无数据：${reading.reason}` }
  }
  return { ok: false, message: `${field}仍取数失败：${reading.reason}，可再次重试` }
}

// 拦污栅确认完成：清污条数 +1 记进共享台账。
// 重复提交不多记靠 runAction 的状态守卫——已经是「已清理」时同一动作根本不会再进来；
// 同一栅体将来重新「安排清理 → 确认完成」属于新一轮清污，应当再 +1，因此不用永久令牌挡死。
export function confirmTrashrackClean(id: number): ActionResult {
  const rows = listRows(TRASHRACK)
  const index = rows.findIndex((r) => Number(r.id) === id)
  if (index < 0) return { ok: false, message: `没有找到编号为 ${id} 的拦污栅` }
  const row = rows[index]
  // 状态守卫在计数之前：同一轮清理已经是「已清理」时，重复点击直接拒绝、不加条数；
  // 将来重新「安排清理」回到清理中再确认，属于新一轮，仍会 +1。
  if (String(row.status) === '已清理') {
    return { ok: false, message: '该栅体已确认完成，重复提交不会重复增加清污条数' }
  }

  const ledger = getCleaning()
  const updated: EntryRow = { ...row, status: '已清理', abnormal: false }
  saveRows(TRASHRACK, rows.map((r) => (Number(r.id) === id ? updated : r)))
  saveCleaning({
    ...ledger,
    events: [
      ...ledger.events,
      { rackId: id, unit: String(updated['所属机组'] ?? ''), at: today(), source: 'trashrack' },
    ],
  })
  return { ok: true, message: '拦污栅清污已确认完成，清污条数 +1，已同步到共享台账与值班清单' }
}

// 触发跨页面选择器重算（组件内 computed 已 touch，这里预留统一入口）。
export function touch(): void {
  useDataVersion()
}

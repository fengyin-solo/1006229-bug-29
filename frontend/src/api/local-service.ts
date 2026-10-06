import { MODULE_BY_KEY } from '@/data/modules'
import {
  allRows,
  database,
  dutyLedger,
  listRows,
  resetModuleData,
  resetRows,
  saveDuty,
  saveRows,
} from '@/data/local-store'
import { measure, measureLimit } from '@/data/measure'
import type {
  ActionResult,
  DutyTask,
  EntryRow,
  FieldIssue,
  MetricRule,
  ModuleMeta,
  OverviewResult,
  PageResult,
} from '@/data/types'

// 页面不做业务判断：列表、动作、统计、导出全部从这里走，保证读到同一份、算出同一口径。

const TODAY = '2026-10-06'
const COOLING_FIELDS = ['供水压力', '供水流量', '水温数值', '滤水器压差'] as const
type CoolingField = (typeof COOLING_FIELDS)[number]

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function fieldIssue(row: EntryRow, field: string): FieldIssue | undefined {
  return row.fieldIssues?.[field]
}

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') {
    return null
  }
  const parsed = typeof value === 'number' ? value : Number(String(value).trim())
  return Number.isFinite(parsed) ? parsed : null
}

export function formatValue(row: EntryRow, field: string): string {
  const issue = fieldIssue(row, field)
  if (issue && (issue.kind === 'failed' || issue.kind === 'empty')) {
    return '暂无'
  }
  const value = row[field]
  if (value === null || value === undefined || value === '') {
    return '—'
  }
  return String(value)
}

/* ----------------------------- 值班清污台账 ----------------------------- */

export function dutyTasks(): DutyTask[] {
  return dutyLedger().tasks.slice().sort((a, b) => b.id - a.id)
}

export function dutyOpenTasks(): DutyTask[] {
  return dutyTasks().filter((task) => task.status !== '已完成')
}

export function cleaningTotal(): number {
  return dutyLedger().tasks.filter((task) => task.status === '已完成').length
}

export function cleaningCountByRack(code: string): number {
  return dutyLedger().tasks.filter(
    (task) => task.status === '已完成' && task.rackCode === code,
  ).length
}

function rackCodeForUnit(unit: string): string {
  const matched = /(\d+)\s*号/.exec(unit)
  if (matched) {
    return `TRAS-${matched[1].padStart(4, '0')}`
  }
  return 'TRAS-0005' // 公用取水口
}

function openTask(idemKey: string): DutyTask | undefined {
  return dutyLedger().tasks.find((task) => task.idemKey === idemKey && task.status !== '已完成')
}

function finishedTask(idemKey: string): DutyTask | undefined {
  return dutyLedger().tasks.find((task) => task.idemKey === idemKey && task.status === '已完成')
}

function createTask(input: Omit<DutyTask, 'id'>): DutyTask {
  const ledger = dutyLedger()
  const task: DutyTask = { ...input, id: ledger.seq + 1 }
  saveDuty({ seq: task.id, tasks: [...ledger.tasks, task] })
  return task
}

function mutateTask(id: number, patch: Partial<DutyTask>): DutyTask | undefined {
  const ledger = dutyLedger()
  const index = ledger.tasks.findIndex((task) => task.id === id)
  if (index < 0) {
    return undefined
  }
  const updated = { ...ledger.tasks[index], ...patch }
  const tasks = [...ledger.tasks]
  tasks[index] = updated
  saveDuty({ ...ledger, tasks })
  return updated
}

/* --------------------------------- 统计 --------------------------------- */

function metricValue(rule: MetricRule, rows: EntryRow[]): number {
  switch (rule.kind) {
    case 'countStatus':
      return rows.filter((row) => String(row.status) === rule.status).length
    case 'sum':
      return rows.reduce((sum, row) => sum + (toNumber(row[rule.field]) ?? 0), 0)
    case 'avg': {
      const values = rows.map((row) => toNumber(row[rule.field])).filter((v): v is number => v !== null)
      return values.length ? Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 100) / 100 : 0
    }
    case 'max':
      return rows.reduce((max, row) => Math.max(max, toNumber(row[rule.field]) ?? max), 0)
    case 'last': {
      const values = rows.map((row) => toNumber(row[rule.field])).filter((v): v is number => v !== null)
      return values.length ? values[values.length - 1] : 0
    }
    case 'countFilled':
      return rows.filter((row) => toNumber(row[rule.field]) !== null || String(row[rule.field] ?? '').trim() !== '').length
    case 'expiring': {
      const now = new Date(TODAY).getTime()
      const horizon = now + rule.days * 24 * 3600 * 1000
      return rows.filter((row) => {
        const raw = String(row[rule.field] ?? '').trim()
        if (!raw) {
          return false
        }
        const t = new Date(raw).getTime()
        return Number.isFinite(t) && t >= now && t <= horizon
      }).length
    }
    case 'custom':
      return rule.name === 'cleaningTotal' ? cleaningTotal() : 0
    default:
      return 0
  }
}

export function moduleStats(key: string): { label: string; value: number }[] {
  const meta = moduleMeta(key)
  const rows = listRows(key)
  return meta.metrics.map((rule) => ({ label: rule.label, value: metricValue(rule, rows) }))
}

/* -------------------------------- 列表读取 ------------------------------- */

function projectRow(key: string, row: EntryRow): EntryRow {
  if (key === 'trashrack') {
    const code = String(row['栅体编号'] ?? '')
    return { ...row, '清污次数': cleaningCountByRack(code) }
  }
  return row
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters).map((row) => projectRow(key, row))
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

/* ------------------------------ 技术供水动作 ----------------------------- */

function collectCoolingReading(row: EntryRow, field: CoolingField): {
  value: number | null
  issue?: FieldIssue
} {
  const code = String(row['系统编号'] ?? '')
  const outcome = measure(code, field, 1)
  return { value: outcome.value, issue: outcome.issue }
}

function applyReadings(row: EntryRow): { updated: EntryRow; notes: string[] } {
  const notes: string[] = []
  const updated: EntryRow = { ...row, fieldIssues: { ...(row.fieldIssues ?? {}) } }
  for (const field of COOLING_FIELDS) {
    const { value, issue } = collectCoolingReading(updated, field)
    if (value === null) {
      updated[field] = null
      if (issue) {
        updated.fieldIssues![field] = issue
        notes.push(
          issue.kind === 'empty'
            ? `${field}：暂无（${issue.reason}）`
            : `${field}：暂无（取数失败：${issue.reason}）`,
        )
      }
    } else {
      updated[field] = value
      if (issue?.kind === 'overlimit') {
        updated.fieldIssues![field] = issue
        notes.push(issue.reason)
      } else {
        delete updated.fieldIssues![field]
      }
    }
  }
  return { updated, notes }
}

// 实测优先：状态由实测值与限值比对决定，限值不参与取值，只做越限判定。
function coolingOverLimit(updated: EntryRow): string | null {
  for (const field of COOLING_FIELDS) {
    const value = toNumber(updated[field])
    const limit = measureLimit('cooling', field)
    if (value !== null && typeof limit === 'number' && value > limit) {
      return `${field}实测 ${value} 超过限值 ${limit}`
    }
  }
  return null
}

function setStatus(row: EntryRow, meta: ModuleMeta, status: string): EntryRow {
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  return {
    ...row,
    status,
    abnormal: meta.abnormalStatuses.includes(status),
    pending: status !== lastStatus,
    stopped: status === '已停运',
  }
}

function coolingSubmitCheck(meta: ModuleMeta, row: EntryRow): ActionResult {
  const { updated: read, notes } = applyReadings(row)
  const over = coolingOverLimit(read)
  const hasHardFailure = COOLING_FIELDS.some((field) => read.fieldIssues?.[field]?.kind === 'failed')
  let updated: EntryRow = { ...read, '检查日期': TODAY }
  updated = setStatus(updated, meta, over ? '异常' : '运行中')
  if (over) {
    updated.abnormal = true
    notes.push(over + '，按实测口径标记异常，限值不替换实测值')
  }
  persistRow(meta.key, row.id, updated)
  return {
    ok: true,
    message: hasHardFailure
      ? '检查已提交：部分测点取数失败，对应读数已留空，请用行内「重试取数」补测；其余按实测值登记。'
      : '检查已提交，实测读数已登记，状态「运行中」。',
    warning: notes.length ? notes.join('；') : undefined,
  }
}

function coolingStop(meta: ModuleMeta, row: EntryRow): ActionResult {
  // 停运即回落异常口径：异常标记清掉，停运单独留痕；停运系统仍留在列表里（终态可查）。
  const updated = setStatus({ ...row, resumed: false }, meta, '已停运')
  persistRow(meta.key, row.id, updated)
  return { ok: true, message: '供水系统已停运，异常计数已回落，停运记录保留在列表中。' }
}

function coolingResume(meta: ModuleMeta, row: EntryRow): ActionResult {
  if (String(row.status) === '运行中') {
    return { ok: false, message: '系统已在运行中；重复复运不再回落指标、不再新增清污任务。' }
  }
  const code = String(row['系统编号'] ?? '')
  const unit = String(row['所属机组'] ?? '公用系统')
  const idemKey = `cooling-resume:${code}`
  const existed = openTask(idemKey) ?? finishedTask(idemKey)

  // 复运重新取数：异常标记、停运标记、滤水器压差一起回到正常口径。
  const { updated: read, notes } = applyReadings(row)
  const over = coolingOverLimit(read)
  let updated = setStatus(read, meta, over ? '异常' : '运行中')
  updated = { ...updated, resumed: true, stopped: false, '检查日期': TODAY }
  if (over) {
    notes.push(over + '，复运后仍超限，按实测口径暂记异常')
  }
  persistRow(meta.key, row.id, updated)

  let taskNote = ''
  if (!existed) {
    const task = createTask({
      idemKey,
      kind: 'cooling-resume',
      refCode: code,
      refId: Number(row.id),
      unit,
      rackCode: rackCodeForUnit(unit),
      title: `${code} 复运后清污（${unit} 拦污栅）`,
      status: '待清理',
      createdAt: TODAY,
    })
    taskNote = `；已联动生成值班清污任务 #${task.id}，请在拦污栅台账确认完成（清污条数全平台同步）`
  } else if (existed.status === '已完成') {
    taskNote = '；该系统此前复运的联动清污已完成并计入台账，本次重复复运不重复计数'
  } else {
    taskNote = `；联动清污任务 #${existed.id} 仍在值班清单中，未重复生成`
  }

  return {
    ok: true,
    message: over
      ? `系统已复运并重新取数，但${over}，状态暂记「异常」，停运与异常回落规则不变${taskNote}。`
      : `系统已复运：异常标记、停运标记、滤水器压差均回到正常口径，状态「运行中」${taskNote}。`,
    warning: notes.length ? notes.join('；') : undefined,
  }
}

export function retryCoolingField(id: number, field: string): ActionResult {
  const rows = listRows('cooling')
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的供水系统` }
  }
  const row = rows[index]
  const issue = row.fieldIssues?.[field]
  if (!issue) {
    return { ok: false, message: `${field} 当前没有待重试的取数失败记录` }
  }
  if (issue.kind === 'empty') {
    return { ok: false, message: `${field} 属于现场实测为空（${issue.reason}），不是取数失败，无需重试` }
  }
  if (issue.retryable === false) {
    return {
      ok: false,
      message: `${field} 取数失败且暂不可重试（${issue.reason}），请先检修测点`,
    }
  }
  const code = String(row['系统编号'] ?? '')
  const attempt = (issue.attempts ?? 1) + 1
  const outcome = measure(code, field as CoolingField, attempt)
  const updated: EntryRow = { ...row, fieldIssues: { ...(row.fieldIssues ?? {}) } }
  if (outcome.value === null && outcome.issue) {
    updated.fieldIssues![field] = { ...outcome.issue, attempts: attempt }
    persistRow('cooling', id, updated)
    return { ok: false, message: `${field} 第 ${attempt} 次取数仍失败：${outcome.issue.reason}` }
  }
  updated[field] = outcome.value
  delete updated.fieldIssues![field]
  persistRow('cooling', id, updated)
  return { ok: true, message: `${field} 重试取数成功，实测值 ${outcome.value} 已登记` }
}

/* ------------------------------ 拦污栅动作 ------------------------------ */

function trashrackArrange(meta: ModuleMeta, row: EntryRow): ActionResult {
  const code = String(row['栅体编号'] ?? '')
  const idemKey = `trashrack-clean:${code}`
  const existing = openTask(idemKey) ?? finishedTask(idemKey)
  let updated = setStatus({ ...row }, meta, '清理中')
  updated = {
    ...updated,
    '清污方式': String(row['清污方式'] ?? '') || '人工清污',
    '清理人员': String(row['清理人员'] ?? '') || '值班人员',
    '清理日期': String(row['清理日期'] ?? '') || TODAY,
  }
  persistRow(meta.key, row.id, updated)
  if (existing?.status === '已完成') {
    return { ok: true, message: `栅体 ${code} 已有完成的清污记录，安排清理不再重复计数。` }
  }
  if (existing) {
    return { ok: true, message: `值班清污任务 #${existing.id} 已在清单中（清理中），未重复生成。` }
  }
  const task = createTask({
    idemKey,
    kind: 'trashrack-clean',
    refCode: code,
    refId: Number(row.id),
    unit: String(row['所属机组'] ?? ''),
    rackCode: code,
    title: `${code} 拦污栅清污（${String(row['所属机组'] ?? '')}）`,
    status: '清理中',
    createdAt: TODAY,
  })
  return { ok: true, message: `已安排清理，值班任务 #${task.id} 进入清理中；完成确认后清污条数 +1。` }
}

function trashrackComplete(meta: ModuleMeta, row: EntryRow): ActionResult {
  const code = String(row['栅体编号'] ?? '')
  // 该栅体上的待办任务：优先台账自建，其次供水复运联动（同一栅体同一时刻只允许一笔）。
  const task =
    openTask(`trashrack-clean:${code}`) ??
    dutyLedger().tasks.find((item) => item.status !== '已完成' && item.rackCode === code)
  // 重复确认：该栅体清污已完成且当前无待办任务时，只同步状态，不重复计数。
  if (!task && String(row.status) === '已清理' && dutyLedger().tasks.some(
    (item) => item.status === '已完成' && item.rackCode === code,
  )) {
    persistRow(meta.key, row.id, setStatus({ ...row }, meta, '已清理'))
    return { ok: true, message: `栅体 ${code} 的清污此前已确认完成，重复确认只回落一次清污条数。` }
  }
  // 清污后按现场实测压差登记：实测优先，超 0.30m 限值也不改成限值。
  const outcome = measure(code, '前后压差', 1)
  const updated: EntryRow = {
    ...row,
    fieldIssues: { ...(row.fieldIssues ?? {}) },
    '清理日期': TODAY,
    '清理人员': String(row['清理人员'] ?? '') || '值班人员',
  }
  const limit = measureLimit('trashrack', '前后压差')
  let overNote: string | undefined
  if (outcome.value === null) {
    updated['前后压差'] = null
    if (outcome.issue) {
      updated.fieldIssues!['前后压差'] = outcome.issue
    }
  } else {
    updated['前后压差'] = outcome.value
    if (outcome.issue?.kind === 'overlimit') {
      updated.fieldIssues!['前后压差'] = outcome.issue
      overNote = outcome.issue.reason
    } else {
      delete updated.fieldIssues!['前后压差']
    }
  }
  let nextStatus = '已清理'
  if (outcome.value !== null && typeof limit === 'number' && outcome.value > limit) {
    nextStatus = '已损坏'
    overNote = overNote ?? `清污后实测压差 ${outcome.value} 仍超过限值 ${limit}，按实测口径登记损坏`
  }
  persistRow(meta.key, row.id, setStatus(updated, meta, nextStatus))

  let countNote = ''
  if (task) {
    mutateTask(task.id, { status: '已完成', completedAt: TODAY, measuredPressure: outcome.value })
    countNote = '；清污条数已 +1，技术供水页脚与导出清单同步'
  } else {
    // 没有经「安排清理」直接确认完成的，补建一条完成记录，台账仍只有一笔。
    const created = createTask({
      idemKey: `trashrack-clean:${code}`,
      kind: 'trashrack-clean',
      refCode: code,
      refId: Number(row.id),
      unit: String(row['所属机组'] ?? ''),
      rackCode: code,
      title: `${code} 拦污栅清污（${String(row['所属机组'] ?? '')}）`,
      status: '已完成',
      createdAt: TODAY,
      completedAt: TODAY,
      measuredPressure: outcome.value,
    })
    mutateTask(created.id, { status: '已完成' })
    countNote = '；已补记值班台账一笔，清污条数 +1，全平台同步'
  }

  return {
    ok: true,
    message:
      nextStatus === '已清理'
        ? `栅体 ${code} 清污完成，实测压差已登记${countNote}。`
        : `栅体 ${code} 清污完成，但${overNote}，状态登记为「已损坏」${countNote}。`,
    warning: outcome.value === null && outcome.issue ? `前后压差取数失败：${outcome.issue.reason}` : overNote,
  }
}

/* ------------------------------ 备品备件动作 ----------------------------- */

function spareConsume(meta: ModuleMeta, row: EntryRow): ActionResult {
  if (row.consumed) {
    return { ok: false, message: '该备件本库存周期已办理过领用，重复提交只扣一次数量，未再扣减。' }
  }
  const stock = toNumber(row['现有数量']) ?? 0
  const nextStock = Math.max(0, stock - 1)
  const minimum = toNumber(row['最低储备量']) ?? 0
  const low = nextStock < minimum
  const updated = setStatus(
    { ...row, '现有数量': nextStock, consumed: true },
    meta,
    low ? '待补充' : '已领用',
  )
  persistRow(meta.key, row.id, updated)
  return {
    ok: true,
    message: low
      ? `领用成功，数量只扣减一次：库存 ${stock} → ${nextStock}，已低于最低储备量 ${minimum}，状态转「待补充」。`
      : `领用成功，数量只扣减一次：库存 ${stock} → ${nextStock}。`,
  }
}

function spareAccept(meta: ModuleMeta, row: EntryRow): ActionResult {
  // 验收补货后重置领用幂等标记，允许下一个库存周期再次领用。
  const updated = setStatus({ ...row, consumed: false }, meta, '已登记')
  persistRow(meta.key, row.id, updated)
  return { ok: true, message: '备件已验收入库，可再次办理领用。' }
}

/* -------------------------------- 动作分发 ------------------------------- */

function findRow(key: string, id: number): { rows: EntryRow[]; index: number } | null {
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  return index < 0 ? null : { rows, index }
}

// 服务端状态守卫：与页面 actionStatuses 声明一致，绕过页面直接调服务时也兜得住。
function guardStatus(meta: ModuleMeta, action: string, status: string): ActionResult | null {
  const allowed = meta.actionStatuses?.[action]
  if (allowed && !allowed.includes(status)) {
    return { ok: false, message: `${meta.entity}当前为「${status}」，不能执行「${action}」` }
  }
  return null
}

function persistRow(key: string, id: number, updated: EntryRow): void {
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const found = findRow(key, id)
  if (!found) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const row = found.rows[found.index]

  // 台账存在待办任务的栅体（含供水复运联动落到「待清理」栅体的任务），允许直接确认完成。
  if (key === 'trashrack' && action === '确认完成') {
    const code = String(row['栅体编号'] ?? '')
    const pendingTask = dutyLedger().tasks.find(
      (task) => task.status !== '已完成' && task.rackCode === code,
    )
    if (pendingTask) {
      return trashrackComplete(meta, row)
    }
    // 该栅体已完成过清污：重复确认幂等同步，不重复计数（绕过「需先安排清理」的守卫）。
    if (dutyLedger().tasks.some((task) => task.status === '已完成' && task.rackCode === code)) {
      return trashrackComplete(meta, row)
    }
  }

  const guard = guardStatus(meta, action, String(row.status))
  if (guard) {
    return guard
  }

  // 模块专用动作（带取数、联动、幂等口径）
  if (key === 'cooling') {
    if (action === '提交检查') return coolingSubmitCheck(meta, row)
    if (action === '停运系统') return coolingStop(meta, row)
    if (action === '系统复运') return coolingResume(meta, row)
  }
  if (key === 'trashrack') {
    if (action === '安排清理') return trashrackArrange(meta, row)
    if (action === '确认完成') return trashrackComplete(meta, row)
  }
  if (key === 'spare') {
    if (action === '领用备件') return spareConsume(meta, row)
    if (action === '办理验收') return spareAccept(meta, row)
  }

  // 通用流转：状态已是目标态时拦截，避免重复提交重复计数
  if (String(row.status) === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  persistRow(key, id, setStatus(row, meta, target))
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

/* -------------------------------- 重置 ---------------------------------- */

export function resetModule(key: string): PageResult {
  if (key === 'cooling' || key === 'trashrack') {
    resetModuleData(['cooling', 'trashrack'])
  } else {
    resetRows(key)
  }
  return listEntries(key)
}

/* -------------------------------- 导出 ---------------------------------- */

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value)
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

const EXTRA_ISSUE_MODULES = new Set(['cooling', 'trashrack'])

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态', '异常标记']
  if (EXTRA_ISSUE_MODULES.has(key)) {
    header.push('取数说明')
  }
  const lines = [header.join(',')]
  for (const row of listEntries(key).items.map((item) => projectRow(key, item))) {
    const issueText = EXTRA_ISSUE_MODULES.has(key)
      ? meta.fields
          .filter((field) => row.fieldIssues?.[field])
          .map((field) => `${field}：${row.fieldIssues![field].reason}`)
          .join('；')
      : ''
    const cells = [row.id, ...meta.fields.map((field) => row[field]), row.status, row.abnormal ? '异常' : '正常']
    if (EXTRA_ISSUE_MODULES.has(key)) {
      cells.push(issueText)
    }
    lines.push(cells.map(csvCell).join(','))
  }
  // 汇总行与页面、概览同一口径现算
  const abnormalCount = listRows(key).filter((row) => meta.abnormalStatuses.includes(String(row.status))).length
  const summaryLabel = (key === 'cooling' || key === 'trashrack')
    ? `异常 ${abnormalCount} 条；清污条数 ${cleaningTotal()}（以值班台账为准）`
    : `异常 ${abnormalCount} 条`
  const totalCols = 1 + meta.fields.length + 1 + 1 + (EXTRA_ISSUE_MODULES.has(key) ? 1 : 0)
  lines.push([...Array(totalCols - 1).fill(''), summaryLabel].map(csvCell).join(','))
  return { filename: `${meta.name}-清单.csv`, content: `﻿${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

/* -------------------------------- 概览 ---------------------------------- */

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => meta.abnormalStatuses.includes(String(row.status))).length,
      stopped: entries.filter((row) => Boolean(row.stopped)).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}

// 供测试脚本直接访问持久层
export const _internals = { database }

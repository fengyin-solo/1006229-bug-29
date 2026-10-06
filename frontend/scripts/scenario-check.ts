import { loadOverview, runAction } from '@/api/local-service'
import { exportCooling } from '@/api/cooling-export'
import { retryReading } from '@/api/cooling-service'
import { listRows } from '@/data/local-store'
import {
  coolingStats,
  displayValue,
  findRow,
  rackCleaningCount,
  readingOf,
  totalCleaningCount,
} from '@/data/selectors'

let pass = 0
let fail = 0
function check(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log('  ✓', name) } else { fail++; console.log('  ✗', name, extra) }
}

const status = (id: number) => String(findRow('cooling', id)?.status)
const abnormalCount = () => coolingStats(listRows('cooling')).abnormal
const stoppedCount = () => coolingStats(listRows('cooling')).stopped

console.log('初始迁移：')
check('异常系统初始=1（仅 COOL-0003 异常态）', abnormalCount() === 1, `got ${abnormalCount()}`)
check('停运系统初始=1（COOL-0004 留在列表）', stoppedCount() === 1)
check('COOL-0005 早期 0 流量迁为取数失败', readingOf('cooling', 5, '供水流量')?.state === 'failed')
check('COOL-0005 流量值留空(null)', readingOf('cooling', 5, '供水流量')?.value === null)
check('COOL-0002 空流量是 empty 而非 failed', readingOf('cooling', 2, '供水流量')?.state === 'empty')
check('COOL-0003 压差0.24 越限但保留实测', (() => {
  const v = displayValue('cooling', findRow('cooling', 3)!, '滤水器压差')
  return v.state === 'ok' && v.overLimit && v.text === '0.24'
})())
check('TRAS-0004 压差0.34 越限保留', displayValue('trashrack', findRow('trashrack', 4)!, '前后压差').overLimit === true)

console.log('清污台账初始：')
const baseTotal = totalCleaningCount()
check('历史底数合计=11 (3+5+2+1)', baseTotal === 11, `got ${baseTotal}`)

console.log('提交检查 COOL-0001（流量首次取数失败）：')
let r = runAction('cooling', 1, '提交检查')
check('返回 ok=false（取数失败，不是数据空）', r.ok === false)
check('警告标注 failed 且有原因', r.warnings!.some((w) => w.field === '供水流量' && w.state === 'failed' && w.reason.includes('通信中断')))
check('状态仍为待检查（未落地运行中）', status(1) === '待检查')

console.log('重试流量一次：')
r = retryReading('cooling', 1, '供水流量')
check('重试成功取到33.6', r.ok === true && readingOf('cooling', 1, '供水流量')?.value === 33.6)

console.log('再次提交（全部成功，进入运行中）：')
r = runAction('cooling', 1, '提交检查')
check('ok=true', r.ok === true, r.message)
check('状态=运行中', status(1) === '运行中')

console.log('系统复运 COOL-0003（异常->运行中）：')
const abBefore = abnormalCount()
r = runAction('cooling', 3, '系统复运')
check('ok=true', r.ok === true, r.message)
check('状态=运行中', status(3) === '运行中')
check('异常数 -1', abnormalCount() === abBefore - 1, `before ${abBefore} after ${abnormalCount()}`)
check('滤水器压差回落到0.09', readingOf('cooling', 3, '滤水器压差')?.value === 0.09)
check('回落压差不再越限', displayValue('cooling', findRow('cooling', 3)!, '滤水器压差').overLimit === false)

console.log('重复复运 COOL-0003：')
r = runAction('cooling', 3, '系统复运')
check('被拒绝且异常数不变', r.ok === false && abnormalCount() === abBefore - 1, r.message)

console.log('停运系统 COOL-0004 复运：')
check('复运前停运计数=1', stoppedCount() === 1)
r = runAction('cooling', 4, '系统复运')
check('ok=true', r.ok === true, r.message)
check('状态=运行中', status(4) === '运行中')
check('停运标记回落=0', stoppedCount() === 0)
check('异常数仍为0', abnormalCount() === 0)

console.log('拦污栅确认清污 TRAS-0002：')
const tBefore = totalCleaningCount()
r = runAction('trashrack', 2, '确认完成')
check('ok=true 条数+1', r.ok === true && totalCleaningCount() === tBefore + 1, r.message)
check('该栅底数5 变为6', rackCleaningCount(2) === 6)
console.log('重复确认清污（已清理再点）：')
r = runAction('trashrack', 2, '确认完成')
check('被拒绝，条数不重复增加', r.ok === false && totalCleaningCount() === tBefore + 1, r.message)

console.log('同一栅合法的下一轮清污（安排清理→确认完成）应再 +1：')
runAction('trashrack', 2, '安排清理')
r = runAction('trashrack', 2, '确认完成')
check('新一轮清污 +1 成功', r.ok === true && rackCleaningCount(2) === 7 && totalCleaningCount() === tBefore + 2, r.message)

console.log('跨页面清污总数一致性：')
check('选择器总数 = 各栅之和',
  totalCleaningCount() === listRows('trashrack').reduce((s, x) => s + rackCleaningCount(Number(x.id)), 0))

console.log('概览与列表异常口径一致：')
const ov = loadOverview()
const coolMod = ov.modules.find((m) => m.name === '技术供水')
check('概览技术供水异常=列表异常(0)', coolMod!.abnormal === abnormalCount() && coolMod!.abnormal === 0)

console.log('另存清单异常条数：')
const csv = exportCooling().content
check('空值 COOL-0002 流量格留空', (() => {
  const line = csv.split('\n').find((l) => l.startsWith('COOL-0002'))!
  return line.split(',')[3] === ''
})())
check('清单含暂无说明', csv.includes('暂无'))
check('清单含取数失败说明(0005)', csv.includes('取数失败'))

console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
if (fail > 0) process.exit(1)

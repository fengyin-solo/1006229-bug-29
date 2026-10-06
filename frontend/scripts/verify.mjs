// 端到端验证：用 esbuild 把数据层打成单文件，在 Node 里模拟 localStorage 跑业务场景。
// 运行：node scripts/verify.mjs
import { build } from 'esbuild'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'

const entry = join(tmpdir(), 'service-entry.ts')
writeFileSync(
  entry,
  `export * from '${process.cwd()}/src/api/local-service.ts'\nexport * from '${process.cwd()}/src/data/migrate.ts'\nexport * from '${process.cwd()}/src/data/local-store.ts'\n`,
)
const result = await build({
  entryPoints: [entry],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  write: false,
  alias: { '@': join(process.cwd(), 'src') },
})
const outDir = mkdtempSync(join(tmpdir(), 'om-verify-'))
const outFile = join(outDir, 'service.mjs')
writeFileSync(outFile, result.outputFiles[0].text)

function createEnv() {
  const store = new Map()
  globalThis.window = {
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => void store.set(k, String(v)),
      removeItem: (k) => void store.delete(k),
    },
  }
  return store
}

let passed = 0
function check(name, fn) {
  try {
    fn()
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (error) {
    console.error(`  ✗ ${name}`)
    console.error(`    ${error.message}`)
    process.exitCode = 1
  }
}

// 每个场景一个全新 localStorage，避免缓存串味
async function freshService(seed) {
  createEnv()
  if (seed !== undefined) {
    globalThis.window.localStorage.setItem('hydropower-plant-om:entries', JSON.stringify(seed))
  }
  const url = `${pathToFileURL(outFile).href}?t=${Date.now()}-${Math.random()}`
  return import(url)
}

const rowById = (svc, key, id) => svc.listEntries(key).items.find((r) => r.id === id)

console.log('1) 迁移：老数据按编号保留、缺项补入、版本升级')
{
  const svc = await freshService({ cooling: [{ id: 1, status: '异常', pending: true, abnormal: true, '系统编号': 'COOL-0001', '检查日期': '2026-08-01' }] })
  const cooling = svc.listEntries('cooling').items
  check('老记录 COOL-0001 原编号保留', () => assert.equal(cooling.some((r) => r.id === 1 && r['系统编号'] === 'COOL-0001'), true))
  check('种子新增记录 COOL-0002..0009 一并补入', () => assert.equal(cooling.length >= 9, true))
  check('数据库版本升到 v2', () => assert.equal(svc._internals.database().version, 2))
}

console.log('2) 迁移：早期误记 0 按检查日期回填（0008），占位文本也回填（0003）')
{
  const svc = await freshService()
  const r8 = rowById(svc, 'cooling', 8)
  check('COOL-0008 早期 0 值回填为实测流量 0.29', () => assert.equal(r8['供水流量'], 0.29))
  check('COOL-0008 压力等其余测点也回填', () => assert.ok(r8['供水压力'] > 0))
  const r3 = rowById(svc, 'cooling', 3)
  check('COOL-0003 占位文本按早期无效读数重新取数', () => assert.equal(typeof r3['供水流量'], 'number'))
  check('COOL-0003 回填后仍保持「异常」状态（老状态保留）', () => assert.equal(r3.status, '异常'))
}

console.log('3) 取数：失败留空给原因+重试；实测为空不重试；瞬态失败重试成功')
{
  const svc = await freshService()
  // COOL-0004 当前流量 0.3（旧读数），提交检查时第一次取数瞬态失败
  const submit = svc.runAction('cooling', 4, '提交检查')
  check('0004 提交返回 ok 并带取数失败提示', () => assert.equal(submit.ok, true))
  const r4a = rowById(svc, 'cooling', 4)
  check('0004 流量留空（暂无）', () => assert.equal(r4a['供水流量'], null))
  check('0004 流量失败原因可重试', () => assert.equal(r4a.fieldIssues['供水流量'].retryable, true))
  const retryFail = svc.retryCoolingField(4, '供水流量')
  check('0004 重试取数成功（第二次）', () => assert.equal(retryFail.ok, true))
  const r4b = rowById(svc, 'cooling', 4)
  check('0004 重试后实测 0.32 登记且问题清除', () => {
    assert.equal(r4b['供水流量'], 0.32)
    assert.equal(r4b.fieldIssues['供水流量'], undefined)
  })

  const r5 = rowById(svc, 'cooling', 5)
  check('0005 备用管路流量为空（empty）', () => assert.equal(r5['供水流量'], null))
  const emptyRetry = svc.retryCoolingField(5, '供水流量')
  check('0005 实测为空不提供重试', () => assert.equal(emptyRetry.ok, false))

  const r6 = rowById(svc, 'cooling', 6)
  check('0006 传感器故障留空且不可重试', () => {
    assert.equal(r6['供水流量'], null)
    assert.equal(r6.fieldIssues['供水流量'].retryable, false)
  })
}

console.log('4) 实测优先：越限保留实测值并标异常')
{
  const svc = await freshService()
  const r7 = rowById(svc, 'cooling', 7)
  check('0007 滤水器压差保留实测 0.092（未被限值 0.08 替换）', () => assert.equal(r7['滤水器压差'], 0.092))
  check('0007 越限说明挂在字段上', () => assert.equal(r7.fieldIssues['滤水器压差'].kind, 'overlimit'))
}

console.log('5) 停运 → 复运：异常/停运/压差归位，重复复运只回落一次')
{
  const svc = await freshService()
  const beforeAbn = svc.moduleStats('cooling').find((s) => s.label === '异常系统').value
  check('初始异常系统数为 3', () => assert.equal(beforeAbn, 3))
  // 先停运异常系统 0007
  svc.runAction('cooling', 7, '停运系统')
  const r7stop = rowById(svc, 'cooling', 7)
  check('0007 停运后异常标记清除、停运标记置位', () => {
    assert.equal(r7stop.abnormal, false)
    assert.equal(r7stop.stopped, true)
  })
  check('停运后异常量回落为 2', () => assert.equal(svc.moduleStats('cooling').find((s) => s.label === '异常系统').value, 2))
  check('停运记录仍留在列表中', () => assert.ok(rowById(svc, 'cooling', 7)))

  // 复运 0009（已停运，压差 0）
  const resume = svc.runAction('cooling', 9, '系统复运')
  check('0009 复运成功', () => assert.equal(resume.ok, true))
  const r9 = rowById(svc, 'cooling', 9)
  check('0009 复运后运行中、停运标记清除', () => {
    assert.equal(r9.status, '运行中')
    assert.equal(r9.stopped, false)
    assert.equal(r9.abnormal, false)
  })
  check('0009 滤水器压差重新取数回到正常口径（>0）', () => assert.ok(r9['滤水器压差'] > 0))
  check('复运生成一条联动清污任务', () => assert.equal(svc.dutyOpenTasks().filter((t) => t.kind === 'cooling-resume').length, 1))
  check('复运联动任务关联对应栅体 TRAS-0004', () => assert.equal(svc.dutyOpenTasks()[0].rackCode, 'TRAS-0004'))

  // 重复复运：幂等
  const again = svc.runAction('cooling', 9, '系统复运')
  check('重复复运被拦截且不新增任务', () => {
    assert.equal(again.ok, false)
    assert.equal(svc.dutyTasks().filter((t) => t.idemKey === 'cooling-resume:COOL-0009').length, 1)
  })
  check('跨页清污条数仍为 0（任务未完成前不计数）', () => assert.equal(svc.cleaningTotal(), 0))
}

console.log('6) 值班清单 ↔ 拦污栅台账联动，清污条数全平台相同')
{
  const svc = await freshService()
  svc.runAction('cooling', 9, '系统复运')
  // 联动任务（TRAS-0004）在台账里确认完成
  const complete = svc.runAction('trashrack', 4, '确认完成')
  check('台账确认完成联动任务', () => assert.equal(complete.ok, true))
  check('完成后清污条数 1', () => assert.equal(svc.cleaningTotal(), 1))
  const rack4 = rowById(svc, 'trashrack', 4)
  check('栅体行清污次数投影为 1（台账为唯一口径）', () => assert.equal(rack4['清污次数'], 1))
  const again = svc.runAction('trashrack', 4, '确认完成')
  check('重复确认完成不重复计数', () => {
    assert.equal(again.ok, true)
    assert.equal(svc.cleaningTotal(), 1)
  })
  // 台账自身安排清理 → 完成
  svc.runAction('trashrack', 1, '安排清理')
  svc.runAction('trashrack', 1, '确认完成')
  check('台账清污 1 号栅后总条数 2', () => assert.equal(svc.cleaningTotal(), 2))
  svc.runAction('trashrack', 1, '安排清理')
  check('同一栅体重复安排不重复建任务', () => {
    assert.equal(svc.dutyTasks().filter((t) => t.idemKey === 'trashrack-clean:TRAS-0001').length, 1)
  })
}

console.log('7) 列表 / 概览 / 导出同一口径')
{
  const svc = await freshService()
  const listAbn = svc.listEntries('cooling').items.filter((r) => r.status === '异常').length
  const cardAbn = svc.moduleStats('cooling').find((s) => s.label === '异常系统').value
  const overviewAbn = svc.loadOverview().modules.find((m) => m.name === '技术供水').abnormal
  const csv = svc.exportEntries('cooling').content
  check('列表/卡片/概览异常数一致', () => assert.equal(listAbn === cardAbn && cardAbn === overviewAbn, true))
  check('导出清单汇总行异常条数一致', () => assert.match(csv, new RegExp(`异常 ${listAbn} 条`)))
  check('导出清单含取数说明列', () => assert.match(csv, /取数说明/))
  check('导出中越限原因写出', () => assert.match(csv, /实测值 0\.092 MPa 超过限值 0\.08 MPa/))
  check('导出含清污条数汇总', () => assert.match(csv, /清污条数 0/))
}

console.log('8) 备件领用幂等：重复提交只扣一次')
{
  const svc = await freshService()
  const first = svc.runAction('spare', 2, '领用备件')
  check('首次领用扣 1（20→19）', () => {
    assert.equal(first.ok, true)
    assert.equal(rowById(svc, 'spare', 2)['现有数量'], 19)
  })
  const second = svc.runAction('spare', 2, '领用备件')
  check('再次领用拦截，库存仍 19', () => {
    assert.equal(second.ok, false)
    assert.equal(rowById(svc, 'spare', 2)['现有数量'], 19)
  })
  svc.runAction('spare', 2, '提交补充')
  svc.runAction('spare', 2, '办理验收')
  const reConsume = svc.runAction('spare', 2, '领用备件')
  check('补货验收后可再次领用（19→18）', () => {
    assert.equal(reConsume.ok, true)
    assert.equal(rowById(svc, 'spare', 2)['现有数量'], 18)
  })
  const low = svc.runAction('spare', 4, '领用备件')
  check('低于最低储备量转待补充并提示', () => {
    assert.equal(low.ok, true)
    assert.equal(rowById(svc, 'spare', 4).status, '待补充')
  })
}

console.log('9) 老版本（无版本壳）数据可迁移')
{
  const legacy = { trashrack: [{ id: 1, status: '已损坏', pending: false, abnormal: false, '栅体编号': 'TRAS-0001', '前后压差': '0.35' }] }
  const svc = await freshService(legacy)
  const r1 = rowById(svc, 'trashrack', 1)
  check('老栅体编号保留、压差字符串数值化、异常按状态重算', () => {
    assert.equal(r1['前后压差'], 0.35)
    assert.equal(r1.abnormal, true)
  })
  check('其余栅体（缺项）补入 5 条', () => assert.equal(svc.listEntries('trashrack').items.length, 5))
}

console.log('10) 动作状态守卫：错误状态下动作被服务端拦截')
{
  const svc = await freshService()
  check('运行中的系统不能直接复运（应先异常或停运）', () => assert.equal(svc.runAction('cooling', 1, '系统复运').ok, false))
  check('已停运系统不能直接提交检查（应先复运）', () => assert.equal(svc.runAction('cooling', 9, '提交检查').ok, false))
  check('待清理栅体不能直接确认完成（应先安排清理）', () => assert.equal(svc.runAction('trashrack', 1, '确认完成').ok, false))
}

console.log(`\n${process.exitCode ? '存在失败用例' : `全部 ${passed} 项检查通过`}`)

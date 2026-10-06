<template>
  <section class="page" data-module="duty">
    <header class="page-head">
      <div>
        <h2>值班清单</h2>
        <p class="page-desc">当班待办直接读技术供水与拦污栅台账：异常 / 停运系统、取不到或暂无的测点、清污条数，改一处这里同步变。</p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="refresh">刷新清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="card in cards" :key="card.label" class="stat-card">
        <span class="stat-label">{{ card.label }}</span>
        <strong class="stat-value">{{ card.value }}</strong>
      </article>
    </div>

    <h3 class="block-title">技术供水待办</h3>
    <table class="data-table">
      <thead>
        <tr><th>系统编号</th><th>状态</th><th>待办测点</th><th>操作</th></tr>
      </thead>
      <tbody>
        <tr v-for="item in coolingTodos" :key="String(item.row.id)">
          <td>{{ item.row['系统编号'] }}</td>
          <td>{{ item.row.status }}</td>
          <td>
            <div v-for="p in item.problems" :key="p.field" class="todo-line">
              <strong>{{ p.field }}</strong>
              <em class="tag" :class="p.state === 'failed' ? 'tag-fail' : 'tag-empty'">
                {{ p.state === 'failed' ? '取数失败' : '暂无' }}
              </em>
              <span class="muted">{{ p.reason }}</span>
            </div>
          </td>
          <td>
            <button
              v-for="p in item.problems"
              :key="p.field"
              class="link retry"
              type="button"
              @click="retry(Number(item.row.id), p.field)"
            >重试 {{ p.field }}</button>
          </td>
        </tr>
        <tr v-if="!coolingTodos.length">
          <td colspan="4" class="empty-state">暂无技术供水待办，异常 / 停运与取数问题都已清零</td>
        </tr>
      </tbody>
    </table>

    <h3 class="block-title">拦污栅清污台账</h3>
    <table class="data-table">
      <thead>
        <tr><th>栅体编号</th><th>所属机组</th><th>状态</th><th>前后压差</th><th>历史+新增清污条数</th></tr>
      </thead>
      <tbody>
        <tr v-for="rack in racks" :key="String(rack.id)">
          <td>{{ rack['栅体编号'] }}</td>
          <td>{{ rack['所属机组'] }}</td>
          <td>{{ rack.status }}</td>
          <td>
            <span :class="{ 'over-limit': pressure(rack).overLimit }">{{ pressure(rack).text }}{{ pressure(rack).unit }}</span>
            <em v-if="pressure(rack).overLimit" class="tag tag-fail">越限</em>
          </td>
          <td>{{ rackCount(rack) }}</td>
        </tr>
      </tbody>
      <tfoot>
        <tr><td colspan="4">累计清污条数（跨页面相同）</td><td>{{ cleaningTotal }}</td></tr>
      </tfoot>
    </table>

    <footer class="page-foot">
      <span>取数失败显示原因并可重试；暂无数据表示测点无数值而非取数失败。</span>
      <RouterLink class="link" to="/cooling">前往技术供水</RouterLink>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import { retryReading } from '@/api/cooling-service'
import { COOLING_MEASURE_FIELDS } from '@/data/domain'
import { listRows } from '@/data/local-store'
import {
  coolingStats,
  displayValue,
  moduleReadingAlerts,
  rackCleaningCount,
  totalCleaningCount,
  type DisplayValue,
  type ReadingAlert,
} from '@/data/selectors'
import type { EntryRow } from '@/data/types'

const tick = ref(0)
const coolingRows = computed(() => {
  void tick.value
  return listRows('cooling')
})
const racks = computed(() => {
  void tick.value
  return listRows('trashrack')
})

const stats = computed(() => coolingStats(coolingRows.value))
const cleaningTotal = computed(() => totalCleaningCount())

const cards = computed(() => [
  { label: '异常系统', value: stats.value.abnormal },
  { label: '停运系统', value: stats.value.stopped },
  { label: '待检查系统', value: stats.value.pending },
  { label: '累计清污条数', value: cleaningTotal.value },
])

type Todo = { row: EntryRow; problems: ReadingAlert[] }

// 待办 = 异常/停运系统，或还有取数失败 / 暂无测点的系统。
const coolingTodos = computed<Todo[]>(() => {
  const alertMap = new Map<number, ReadingAlert[]>()
  for (const item of moduleReadingAlerts('cooling', coolingRows.value, COOLING_MEASURE_FIELDS)) {
    alertMap.set(Number(item.row.id), item.problems)
  }
  return coolingRows.value
    .filter((row) => {
      const s = String(row.status)
      return s === '异常' || s === '已停运' || s === '待检查' || alertMap.has(Number(row.id))
    })
    .map((row) => ({ row, problems: alertMap.get(Number(row.id)) ?? [] }))
})

function pressure(row: EntryRow): DisplayValue {
  return displayValue('trashrack', row, '前后压差')
}

function rackCount(row: EntryRow): number {
  return rackCleaningCount(Number(row.id))
}

function retry(id: number, field: string) {
  retryReading('cooling', id, field)
  refresh()
}

function refresh() {
  tick.value += 1
}

onMounted(refresh)
</script>

<style scoped>
.block-title { margin: 16px 0 8px; font-size: 15px; }
.todo-line { margin: 2px 0; }
.tag { font-style: normal; font-size: 11px; border-radius: 4px; padding: 0 6px; margin: 0 6px; }
.tag-fail { background: #fee4e2; color: #b42318; }
.tag-empty { background: #eef2f7; color: #475467; }
.muted { color: var(--muted); font-size: 12px; }
.retry { margin-right: 8px; }
.over-limit { color: #b42318; font-weight: 600; }
tfoot td { font-weight: 600; background: #f8fafc; }
</style>

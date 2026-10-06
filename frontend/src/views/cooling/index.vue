<template>
  <section class="page" data-module="cooling">
    <header class="page-head">
      <div>
        <h2>技术供水管理</h2>
        <p class="page-desc">维护供水系统，围绕系统编号、供水类型、供水压力、供水流量做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="submitPending">提交检查（待检查系统）</button>
        <button class="btn" type="button" @click="exportRows">另存技术供水清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in statsCards" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
      <span class="legend-item">全电站累计清污条数：{{ cleaningTotal }}</span>
    </p>

    <div v-if="notice" class="notice" :class="notice.ok ? 'notice-ok' : 'notice-warn'">
      <span>{{ notice.text }}</span>
      <ul v-if="notice.warnings.length" class="notice-list">
        <li v-for="w in notice.warnings" :key="w.field">
          {{ w.field }}：
          <template v-if="w.state === 'failed'">取数失败 —— {{ w.reason }}</template>
          <template v-else>暂无数据 —— {{ w.reason }}</template>
        </li>
      </ul>
    </div>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">
            <template v-if="measureColumns.includes(column)">
              <span v-if="cell(row, column).state === 'ok'" :class="{ 'over-limit': cell(row, column).overLimit }">
                {{ cell(row, column).text }}{{ cell(row, column).unit }}
                <em v-if="cell(row, column).overLimit" class="flag" :title="cell(row, column).reason">越限</em>
              </span>
              <template v-else>
                <span class="muted-cell">{{ cell(row, column).text }}</span>
                <button class="link retry" type="button" @click="retry(row, column)">重试取数</button>
                <span class="reason-tip" :title="cell(row, column).reason + (cell(row, column).basis ? '；依据：' + cell(row, column).basis : '')">ⓘ</span>
              </template>
            </template>
            <template v-else>{{ row[column] ?? '—' }}</template>
          </td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button v-if="String(row.status) === '待检查'" class="link" type="button" @click="runAction('提交检查', row)">提交检查</button>
            <button v-if="String(row.status) !== '异常'" class="link" type="button" @click="runAction('标记异常', row)">标记异常</button>
            <button v-if="String(row.status) !== '已停运'" class="link" type="button" @click="runAction('停运系统', row)">停运系统</button>
            <button
              v-if="String(row.status) === '异常' || String(row.status) === '已停运'"
              class="link primary-link"
              type="button"
              @click="runAction('系统复运', row)"
            >系统复运</button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无技术供水数据</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>
        共 {{ total }} 条技术供水记录 · 异常系统 {{ stats.abnormal }} · 停运系统 {{ stats.stopped }} · 累计清污条数 {{ cleaningTotal }}
      </span>
      <span class="rule-note">
        空值留空并说明原因；早期误记 0（检查日期早于 {{ cutoff }} 且 0 与正常运行并存）按取数失败重新取数；实测与限值冲突时以实测为准。
      </span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import { downloadCooling } from '@/api/cooling-export'
import { retryReading } from '@/api/cooling-service'
import { COOLING_MEASURE_FIELDS, ZERO_BACKFILL_CUTOFF } from '@/data/domain'
import {
  coolingStats,
  displayValue,
  totalCleaningCount,
  type DisplayValue,
} from '@/data/selectors'
import type { EntryRow, ReadingWarning } from '@/data/types'

const meta = moduleMeta('cooling')
const columns = ['系统编号', '供水类型', '供水压力', '供水流量', '水温数值', '滤水器压差', '检查日期', '系统状态']
const measureColumns = COOLING_MEASURE_FIELDS
const statuses = ['待检查', '运行中', '异常', '已停运']
const cutoff = ZERO_BACKFILL_CUTOFF

const rows = ref<EntryRow[]>([])
const total = ref(0)
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 2)
const notice = ref<{ ok: boolean; text: string; warnings: ReadingWarning[] } | null>(null)

const stats = computed(() => coolingStats(rows.value))
const cleaningTotal = computed(() => totalCleaningCount())
const statsCards = computed(() => [
  { label: '运行系统', value: stats.value.running },
  { label: '异常系统', value: stats.value.abnormal },
  { label: '待检查系统', value: stats.value.pending },
  { label: '停运系统', value: stats.value.stopped },
])
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)
// 仅用于在页面上提示“哪些系统还挂着取数失败/暂无”，与值班清单读同一批。
function cell(row: EntryRow, field: string): DisplayValue {
  return displayValue(meta.key, row, field)
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadCooling()
}

function submitPending() {
  const row = rows.value.find((r) => String(r.status) === '待检查')
  if (!row) {
    notice.value = { ok: false, text: '当前没有待检查的供水系统', warnings: [] }
    return
  }
  runAction('提交检查', row)
}

function runAction(action: string, row: EntryRow) {
  const result = applyAction(meta.key, Number(row.id), action)
  notice.value = {
    ok: result.ok,
    text: result.message,
    warnings: result.warnings ?? [],
  }
  reload()
}

function retry(row: EntryRow, field: string) {
  const result = retryReading(meta.key, Number(row.id), field)
  notice.value = { ok: result.ok, text: result.message, warnings: [] }
  reload()
}

function reload() {
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    notice.value = {
      ok: false,
      text: error instanceof Error ? error.message : '技术供水列表读取失败',
      warnings: [],
    }
  }
}

onMounted(reload)
</script>

<style scoped>
.notice { margin: 8px 0 12px; padding: 8px 12px; border-radius: 6px; font-size: 13px; }
.notice-ok { background: #ecfdf3; border: 1px solid #73e2a3; color: #067647; }
.notice-warn { background: #fffbfa; border: 1px solid #fda29b; color: #b42318; }
.notice-list { margin: 6px 0 0; padding-left: 18px; }
.over-limit { color: #b42318; font-weight: 600; }
.flag { font-style: normal; font-size: 11px; background: #fee4e2; border-radius: 4px; padding: 0 4px; margin-left: 4px; }
.muted-cell { color: #b42318; }
.retry { margin-left: 6px; }
.reason-tip { color: var(--muted); margin-left: 4px; cursor: help; }
.primary-link { color: #067647; font-weight: 600; }
.rule-note { color: var(--muted); }
</style>

<template>
  <section class="page" data-module="trashrack">
    <header class="page-head">
      <div>
        <h2>拦污栅管理</h2>
        <p class="page-desc">维护拦污栅，围绕栅体编号、所属机组、前后压差、清污次数做登记、筛选与状态流转；清污条数与技术供水、值班清单共用同一台账。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记拦污栅</button>
        <button class="btn" type="button" @click="exportRows">导出拦污栅清单</button>
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
      <span class="legend-item">跨页面累计清污条数：{{ cleaningTotal }}（与技术供水、值班清单相同）</span>
    </p>

    <div v-if="notice" class="notice" :class="notice.ok ? 'notice-ok' : 'notice-warn'">
      <span>{{ notice.text }}</span>
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
            <template v-if="column === '前后压差'">
              <span :class="{ 'over-limit': pressure(row).overLimit }">
                {{ pressure(row).text }}{{ pressure(row).unit }}
                <em v-if="pressure(row).overLimit" class="flag" :title="pressure(row).reason">越限</em>
              </span>
            </template>
            <template v-else-if="column === '清污次数'">{{ rackCount(row) }}</template>
            <template v-else>{{ row[column] ?? '—' }}</template>
          </td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in availableActions(row)"
              :key="action"
              class="link"
              :class="{ 'primary-link': action === '确认完成' }"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无拦污栅数据，可先登记拦污栅</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条拦污栅记录 · 累计清污条数 {{ cleaningTotal }}</span>
      <span class="rule-note">清污条数以共享台账为准，技术供水页与值班清单读到同一个数；实测压差超限只标记不改值。</span>
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
import { downloadTrashrack } from '@/api/trashrack-export'
import {
  displayValue,
  maxTrashrackPressure,
  rackCleaningCount,
  totalCleaningCount,
  trashrackStats,
  type DisplayValue,
} from '@/data/selectors'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('trashrack')
const columns = ['栅体编号', '所属机组', '前后压差', '清污次数', '清污方式', '清理日期', '清理人员', '栅体状态']
const allActions = ['安排清理', '确认完成', '登记损坏']
const statuses = ['待清理', '清理中', '已清理', '已损坏']

const rows = ref<EntryRow[]>([])
const total = ref(0)
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 2)
const notice = ref<{ ok: boolean; text: string } | null>(null)

const stats = computed(() => trashrackStats(rows.value))
const cleaningTotal = computed(() => totalCleaningCount())
const maxPressure = computed(() => maxTrashrackPressure(rows.value))
const statsCards = computed(() => [
  { label: '待清理栅体', value: stats.value.waiting },
  { label: '已清理栅体', value: stats.value.cleaned },
  { label: '最大压差(MPa)', value: maxPressure.value === null ? '暂无' : maxPressure.value },
  { label: '累计清污条数', value: cleaningTotal.value },
])
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function pressure(row: EntryRow): DisplayValue {
  return displayValue(meta.key, row, '前后压差')
}

function rackCount(row: EntryRow): number {
  return rackCleaningCount(Number(row.id))
}

// 已经是目标态的动作不再渲染按钮，避免重复提交多记。
function availableActions(row: EntryRow): string[] {
  return allActions.filter((action) => {
    const target = meta.actionTargets[action]
    return String(row.status) !== target
  })
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadTrashrack()
}

function openCreate() {
  notice.value = { ok: false, text: '拦污栅登记入口尚未接入审批流' }
}

function runAction(action: string, row: EntryRow) {
  const result = applyAction(meta.key, Number(row.id), action)
  notice.value = { ok: result.ok, text: result.message }
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
      text: error instanceof Error ? error.message : '拦污栅列表读取失败',
    }
  }
}

onMounted(reload)
</script>

<style scoped>
.notice { margin: 8px 0 12px; padding: 8px 12px; border-radius: 6px; font-size: 13px; }
.notice-ok { background: #ecfdf3; border: 1px solid #73e2a3; color: #067647; }
.notice-warn { background: #fffbfa; border: 1px solid #fda29b; color: #b42318; }
.over-limit { color: #b42318; font-weight: 600; }
.flag { font-style: normal; font-size: 11px; background: #fee4e2; border-radius: 4px; padding: 0 4px; margin-left: 4px; }
.primary-link { color: #067647; font-weight: 600; }
.rule-note { color: var(--muted); }
</style>

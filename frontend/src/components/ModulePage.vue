<template>
  <section class="page" :data-module="meta.key">
    <header class="page-head">
      <div>
        <h2>{{ meta.name }}</h2>
        <p class="page-desc">{{ meta.desc }}</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记{{ meta.entity }}</button>
        <button class="btn" type="button" @click="exportRows">导出{{ meta.name }}清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <!-- 拦污栅值班清单：与台账同源，联动显示待办与已完成清污条数 -->
    <section v-if="meta.key === 'trashrack'" class="duty-panel">
      <header class="duty-head">
        <h3>值班清污清单</h3>
        <span class="duty-total">已完成清污条数：{{ cleaningTotal() }} 条（与技术供水页脚、导出清单同源）</span>
      </header>
      <table class="data-table duty-table">
        <thead>
          <tr><th>任务号</th><th>事项</th><th>关联栅体</th><th>所属机组</th><th>来源</th><th>状态</th><th>完成日期</th></tr>
        </thead>
        <tbody>
          <tr v-for="task in dutyList" :key="task.id">
            <td>#{{ task.id }}</td>
            <td>{{ task.title }}</td>
            <td>{{ task.rackCode }}</td>
            <td>{{ task.unit || '公用' }}</td>
            <td>{{ task.kind === 'cooling-resume' ? '供水复运联动' : '拦污栅台账' }}</td>
            <td>
              <span :class="['duty-status', task.status === '已完成' ? 'done' : task.status === '清理中' ? 'doing' : 'todo']">
                {{ task.status }}
              </span>
            </td>
            <td>{{ task.completedAt ?? '—' }}</td>
          </tr>
          <tr v-if="!dutyList.length">
            <td colspan="7" class="empty-state">暂无值班清污任务；技术供水复运或安排清理后会自动进入本清单</td>
          </tr>
        </tbody>
      </table>
    </section>

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
            <span :title="cellTitle(row, column)">{{ displayCell(row, column) }}</span>
            <button
              v-if="canRetry(row, column)"
              class="link retry-link"
              type="button"
              @click="retryField(row, column)"
            >
              重试取数
            </button>
          </td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in availableActions(row)"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无{{ meta.name }}数据，可先登记{{ meta.entity }}</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条{{ meta.name }}记录<template v-if="meta.key === 'cooling'">；异常系统 {{ abnormalCount }} 个 · 停运 {{ stoppedCount }} 个 · 联动清污条数 {{ cleaningTotal() }}（以值班台账为准）</template></span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
      <span v-else-if="warningMessage" class="warning-text">{{ warningMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  cleaningTotal,
  downloadEntries,
  dutyTasks,
  fieldIssue,
  formatValue,
  listEntries,
  moduleMeta,
  moduleStats,
  retryCoolingField,
  runAction as applyAction,
} from '@/api/local-service'
import type { DutyTask, EntryRow } from '@/data/types'

const props = defineProps<{ moduleKey: string }>()

const meta = moduleMeta(props.moduleKey)
const columns = meta.fields
const filterFields = columns.slice(0, 3)

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const warningMessage = ref('')
const filters = ref<Record<string, string>>({})
const stats = ref<{ label: string; value: number }[]>([])
const dutyList = ref<DutyTask[]>([])

const statusSummary = computed(() =>
  meta.statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

const abnormalCount = computed(
  () => rows.value.filter((row) => meta.abnormalStatuses.includes(String(row.status))).length,
)
const stoppedCount = computed(() => rows.value.filter((row) => Boolean(row.stopped)).length)

function availableActions(row: EntryRow): string[] {
  return meta.actions.filter((action) => {
    const visibleIn = meta.actionStatuses?.[action]
    if (visibleIn) {
      return visibleIn.includes(String(row.status))
    }
    return meta.actionTargets[action] !== String(row.status)
  })
}

function displayCell(row: EntryRow, field: string): string {
  return formatValue(row, field)
}

function cellTitle(row: EntryRow, field: string): string {
  const issue = fieldIssue(row, field)
  if (!issue) {
    return ''
  }
  if (issue.kind === 'overlimit') {
    return issue.reason
  }
  const prefix = issue.kind === 'failed' ? `取数失败：${issue.reason}` : issue.reason
  return issue.retryable ? `${prefix}（可点击重试取数）` : prefix
}

function canRetry(row: EntryRow, field: string): boolean {
  const issue = fieldIssue(row, field)
  return meta.key === 'cooling' && issue?.kind === 'failed' && issue.retryable === true
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
  reload()
}

function openCreate() {
  errorMessage.value = `${meta.entity}登记入口尚未接入审批流`
  warningMessage.value = ''
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  warningMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  warningMessage.value = result.warning ?? ''
  reload()
}

function retryField(row: EntryRow, field: string) {
  errorMessage.value = ''
  warningMessage.value = ''
  const result = retryCoolingField(Number(row.id), field)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  warningMessage.value = result.message
  reload()
}

function reload() {
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    stats.value = moduleStats(meta.key)
    dutyList.value = dutyTasks()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : `${meta.name}列表读取失败`
  }
}

onMounted(reload)
</script>

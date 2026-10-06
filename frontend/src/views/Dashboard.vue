<template>
  <section class="page">
    <header class="page-head">
      <div>
        <h2>运营概览</h2>
        <p class="page-desc">汇总各业务模块的关键指标，先看总量再看异常；指标与各模块列表、另存清单同源。</p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="refresh">重新统计</button>
      </div>
    </header>
    <div class="stat-row">
      <article v-for="card in overview.cards" :key="card.label" class="stat-card">
        <span class="stat-label">{{ card.label }}</span>
        <strong class="stat-value">{{ card.value }}</strong>
      </article>
    </div>
    <table class="data-table">
      <thead>
        <tr><th>业务模块</th><th>登记数</th><th>待处理</th><th>异常量</th></tr>
      </thead>
      <tbody>
        <tr v-for="row in overview.modules" :key="row.name">
          <td>{{ row.name }}</td>
          <td>{{ row.created }}</td>
          <td>{{ row.pending }}</td>
          <td :class="{ 'abnormal-cell': row.abnormal > 0 }">{{ row.abnormal }}</td>
        </tr>
      </tbody>
    </table>
    <footer class="page-foot">
      <span>技术供水异常量按「异常」状态计，复运后与列表、另存清单同步回落；数据保存在本机浏览器。</span>
      <RouterLink class="link" to="/duty">查看值班清单</RouterLink>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onActivated, onMounted, ref } from 'vue'

import { useDataVersion } from '@/data/bus'
import { loadOverview } from '@/api/local-service'
import type { OverviewResult } from '@/data/types'

// touch 数据版本：技术供水复运、拦污栅清污后回到概览页，卡片与异常量即时重算。
const version = ref(0)
const overview = computed<OverviewResult>(() => {
  void version.value
  useDataVersion()
  return loadOverview()
})

function refresh() {
  version.value += 1
}

onMounted(refresh)
onActivated(refresh)
</script>

<style scoped>
.abnormal-cell { color: #b42318; font-weight: 600; }
</style>

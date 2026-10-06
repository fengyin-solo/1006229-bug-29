import { COOLING_MEASURE_FIELDS } from '@/data/domain'
import { listRows } from '@/data/local-store'
import { coolingStats, displayValue } from '@/data/selectors'
import type { EntryRow } from '@/data/types'

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value)
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

// 技术供水清单导出：量测列与页面同源——空值留空，取数失败写明原因；
// 末尾附异常/停运/待检查汇总，保证“另存的清单”里异常条数与列表、概览一致。
export function exportCooling(): { filename: string; content: string } {
  const fields = ['系统编号', '供水类型', '供水压力', '供水流量', '水温数值', '滤水器压差', '检查日期']
  const rows = listRows('cooling')
  const header = [...fields, '当前状态', '取数异常字段及原因']
  const lines = [header.map(csvCell).join(',')]

  for (const row of rows) {
    const reasons: string[] = []
    const cells = fields.map((field) => {
      if (!COOLING_MEASURE_FIELDS.includes(field)) return row[field] ?? ''
      const view = displayValue('cooling', row, field)
      if (view.state === 'ok') return view.text
      if (view.state === 'empty') {
        reasons.push(`${field}：暂无（${view.reason}）`)
        return '' // 空值单独留空
      }
      reasons.push(`${field}：取数失败（${view.reason}）`)
      return '' // 取数失败也留空，原因放末列说明
    })
    lines.push([...cells, row.status, reasons.join('；')].map(csvCell).join(','))
  }

  const stats = coolingStats(rows)
  lines.push('')
  lines.push(['汇总', '运行中', '异常', '已停运', '待检查'].map(csvCell).join(','))
  lines.push(['条数', stats.running, stats.abnormal, stats.stopped, stats.pending].map(csvCell).join(','))

  return { filename: '技术供水-清单.csv', content: `﻿${lines.join('\n')}` }
}

export function downloadCooling(): void {
  const { filename, content } = exportCooling()
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

export type { EntryRow }

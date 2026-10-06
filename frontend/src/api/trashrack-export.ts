import { listRows } from '@/data/local-store'
import { displayValue, rackCleaningCount } from '@/data/selectors'

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value)
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

// 拦污栅清单导出：前后压差取实测口径（越限保留实测），清污次数取共享台账数，
// 与拦污栅页、技术供水页脚、值班清单完全一致。
export function exportTrashrack(): { filename: string; content: string } {
  const fields = ['栅体编号', '所属机组', '清污方式', '清理日期', '清理人员', '栅体状态']
  const rows = listRows('trashrack')
  const header = [fields[0], fields[1], '前后压差', '清污次数', ...fields.slice(2), '当前状态']
  const lines = [header.map(csvCell).join(',')]

  for (const row of rows) {
    const pressure = displayValue('trashrack', row, '前后压差')
    const pressureText = pressure.state === 'ok'
      ? `${pressure.text}${pressure.overLimit ? '(越限,以实测为准)' : ''}`
      : pressure.state === 'empty'
        ? ''
        : ''
    const pressureReason = pressure.state !== 'ok' ? pressure.reason : ''
    const cells = [
      row[fields[0]],
      row[fields[1]],
      pressureText,
      rackCleaningCount(Number(row.id)),
      ...fields.slice(2).map((f) => row[f] ?? ''),
      row.status,
    ]
    if (pressureReason) cells.push(pressureReason)
    lines.push(cells.map(csvCell).join(','))
  }

  const total = rows.reduce((s, r) => s + rackCleaningCount(Number(r.id)), 0)
  lines.push('')
  lines.push(['累计清污条数（与技术供水、值班清单相同）', total].map(csvCell).join(','))

  return { filename: '拦污栅-清单.csv', content: `﻿${lines.join('\n')}` }
}

export function downloadTrashrack(): void {
  const { filename, content } = exportTrashrack()
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

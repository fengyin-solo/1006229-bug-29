import { reactive } from 'vue'

// 极简数据变更总线：任何写操作（动作流转、取数、清污记账）都 bump 一下，
// 跨页面（列表 / 概览 / 值班清单 / 拦污栅台账）的派生选择器跟着重算，保证读到同一份。
const hub = reactive<{ version: number }>({ version: 0 })

export function bumpDataVersion(): void {
  hub.version += 1
}

/** 在 computed 里 touch 一下返回值，数据变更时选择器就会重算。 */
export function useDataVersion(): number {
  return hub.version
}

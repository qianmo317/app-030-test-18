/**
 * 整链运行器：把「归并 → 页面汇总 → 下单汇总表 / 量体明细 / 打印稿 → CSV / XLSX 文件」
 * 串成一条链，返回全部中间产物。每个用例都基于同一份产物做交叉断言，
 * 保证「同一份输入在每一处给出同一组结论」。
 *
 * 基准决策：以页面汇总（buildSummary 输出）为唯一事实源，导出物为被测对象；
 * independentHistogram 提供不经过 buildSummary 的独立复核（见 README）。
 */
import type { Project, SizeRule } from '../../../src/logic/types'
import { runMerge, buildSummary, conservationText, type Summary } from '../../../src/logic/merge'
import {
  buildOrderSheet,
  detailRows,
  detailWorkbookSheets,
  orderSheetToRows,
  orgUnitSheetToRows,
  orderWorkbookSheets,
  specialRows,
  type OrderSheet
} from '../../../src/logic/exporter'
import { toCsvText } from '../../../src/logic/csv'
import type { Sheet } from '../../../src/logic/xlsx'

export const FIXED_GENERATED_AT = new Date(2026, 4, 18, 9, 30, 0)
export const OPERATOR = 'e2e-回归'

export type ChainArtifacts = {
  project: Project
  rule: SizeRule
  mergeMs: number
  summary: Summary
  conservation: string
  orderSheet: OrderSheet
  orderRows: (string | number)[][]
  orgRows: (string | number)[][]
  detailRows: (string | number)[][]
  specialRows: (string | number)[][]
  orderCsv: string
  detailCsv: string
  orderXlsxSheets: Sheet[]
  detailXlsxSheets: Sheet[]
}

export function runChain(project: Project, rule: SizeRule): ChainArtifacts {
  const merge = runMerge(project, rule)
  project.perf = { ...(project.perf ?? {}), mergeMs: merge.durationMs, mergeCount: project.persons.length }
  const summary = buildSummary(project, rule)
  const ctx = { project, rule, summary, operator: OPERATOR, generatedAt: FIXED_GENERATED_AT }
  const orderSheet = buildOrderSheet(ctx)
  const orderRows = orderSheetToRows(orderSheet)
  const orgRows = orgUnitSheetToRows(orderSheet)
  const detail = detailRows(ctx)
  const special = specialRows(ctx)
  return {
    project,
    rule,
    mergeMs: merge.durationMs,
    summary,
    conservation: conservationText(summary),
    orderSheet,
    orderRows,
    orgRows,
    detailRows: detail,
    specialRows: special,
    orderCsv: toCsvText(orderRows),
    detailCsv: toCsvText(detail),
    orderXlsxSheets: orderWorkbookSheets(ctx),
    detailXlsxSheets: detailWorkbookSheets(ctx)
  }
}

export type HistogramEntry = { sizeCode: string; gender: string; isSpecial: boolean; qty: number }

/**
 * 独立直方图：不经过 buildSummary，直接从 persons 原始数据重算分档数量。
 * 用来验证「页面汇总」本身没有算错（双记账）。
 */
export function independentHistogram(project: Project): { entries: HistogramEntry[]; unmerged: number; valid: number } {
  const map = new Map<string, HistogramEntry>()
  let unmerged = 0
  let valid = 0
  for (const person of project.persons) {
    if (person.status !== 'active') continue
    valid += 1
    if (person.specialFlag) {
      const key = `S|${person.specialFlag}|${person.gender}`
      const entry = map.get(key) ?? { sizeCode: person.specialFlag, gender: person.gender, isSpecial: true, qty: 0 }
      entry.qty += 1
      map.set(key, entry)
    } else if (person.result) {
      const key = `R|${person.result.sizeCode}|${person.gender}`
      const entry = map.get(key) ?? { sizeCode: person.result.sizeCode, gender: person.gender, isSpecial: false, qty: 0 }
      entry.qty += 1
      map.set(key, entry)
    } else {
      unmerged += 1
    }
  }
  return { entries: [...map.values()], unmerged, valid }
}

/** 把 summary.allRows 转成与 independentHistogram 相同的可比较形态 */
export function summaryHistogram(summary: Summary): HistogramEntry[] {
  return summary.allRows.map((row) => ({
    sizeCode: row.sizeCode,
    gender: row.gender,
    isSpecial: row.isSpecial,
    qty: row.qty
  }))
}

export function sortedHistogram(entries: HistogramEntry[]): HistogramEntry[] {
  return [...entries].sort((a, b) =>
    `${a.isSpecial}|${a.sizeCode}|${a.gender}`.localeCompare(`${b.isSpecial}|${b.sizeCode}|${b.gender}`)
  )
}

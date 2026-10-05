/**
 * 大批量：整条链的耗时与确定性。
 * 规格书 §8 / §10：5000 人归并 < 200ms；导入 5000 行解析与校验 < 2s。
 * 同一输入跑两次完整链，所有产物必须一致（CSV 逐字节、汇总逐行、XLSX 逐格）。
 * 耗时通过 console.log 打进 TAP 输出（# 开头的诊断行），供回归时对照。
 */
import { test } from 'node:test'
import { makeCheck } from './helpers/check'
import { makeProject, mulberry32 } from './helpers/factory'
import { runChain, sortedHistogram, summaryHistogram } from './helpers/chain'
import { BUILTIN_RULES } from '../../src/logic/sizeRules'
import { IMPORT_TEMPLATE_HEADER, applyImport, buildDryRun, detectHeaderRow, guessMapping } from '../../src/logic/importPlan'
import { fnv1a, parseDelimitedText } from '../../src/logic/csv'
import { runMerge } from '../../src/logic/merge'
import { buildXlsxBlob } from '../../src/logic/xlsx'
import { readXlsxBlob, sheetSignature } from './helpers/xlsxReader'
import type { Project } from '../../src/logic/types'

const rule = BUILTIN_RULES.find((item) => item.version === 'v1.0.0')!
const COUNT = 5000

/** 确定性生成 5000 行量体 CSV（同一 seed 同一文件） */
function buildScaleCsv(seed: number): string {
  const random = mulberry32(seed)
  const lines = [IMPORT_TEMPLATE_HEADER.join(',')]
  for (let i = 1; i <= COUNT; i += 1) {
    const male = i % 2 === 1
    const ranges = rule.fitByChestWaistDiff.find((group) => group.gender === (male ? 'male' : 'female'))!.ranges
    const range = ranges[i % ranges.length]
    const diff = (range.minCm + range.maxCm) / 2
    const height = 150 + Math.floor(random() * 20) * 2.5
    const chest = Math.round((height * 0.52) / 2) * 2
    const special = i % 40 === 0 ? 'PLUS' : ''
    lines.push(
      [
        `量体${String(i).padStart(5, '0')}`,
        male ? '男' : '女',
        `车间${(i % 12) + 1}`,
        i % 2 === 1 ? '春装' : '秋装',
        height,
        50 + (i % 40),
        chest,
        chest - diff,
        special,
        ''
      ].join(',')
    )
  }
  return `${lines.join('\r\n')}\r\n`
}

function importInto(project: Project, csvText: string): { importMs: number } {
  const started = performance.now()
  const rows = parseDelimitedText(csvText)
  const headerIndex = detectHeaderRow(rows)
  const mapping = guessMapping(rows[headerIndex])
  const dataRows = rows
    .slice(headerIndex + 1)
    .map((cells, index) => ({ cells, lineNo: headerIndex + index + 2 }))
  const dryRun = buildDryRun(dataRows, mapping, project, rule, '量体5000行.csv', `量体5000行.csv|${csvText.length}|${fnv1a(csvText)}`)
  const importMs = performance.now() - started
  if (dryRun.counts.error > 0 || dryRun.counts.invalid > 0) {
    throw new Error(`夹具数据不应有错：${JSON.stringify(dryRun.counts)}`)
  }
  applyImport(project, dryRun, rule)
  return { importMs }
}

test('大批量：5000 人整条链 —— 耗时达标、两次运行结果一致', async () => {
  const check = makeCheck('大批量')
  const csvText = buildScaleCsv(20261005)

  // —— 第一遍 ——
  const project1 = makeProject({ name: '大批量回归', ruleVersion: rule.version, batches: ['春装', '秋装'] })
  const { importMs } = importInto(project1, csvText)
  check.eq(project1.persons.length, COUNT, '5000 行全部落地')

  const mergeRuns: number[] = []
  for (let i = 0; i < 3; i += 1) mergeRuns.push(runMerge(project1, rule).durationMs)
  const mergeMedian = [...mergeRuns].sort((a, b) => a - b)[1]

  const chainStarted = performance.now()
  const chain1 = runChain(project1, rule)
  const orderBlob1 = buildXlsxBlob(chain1.orderXlsxSheets)
  const detailBlob1 = buildXlsxBlob(chain1.detailXlsxSheets)
  const chainMs = performance.now() - chainStarted

  console.log(
    `[大批量] 导入解析+校验 ${COUNT} 行：${importMs.toFixed(1)}ms（规格 < 2000ms）；` +
      `归并 3 次：${mergeRuns.map((ms) => ms.toFixed(1)).join(' / ')}ms，中位 ${mergeMedian.toFixed(1)}ms（规格 < 200ms）；` +
      `汇总+下单表+明细+CSV+XLSX 全链：${chainMs.toFixed(1)}ms`
  )
  check.ok(importMs < 2000, `导入 5000 行解析与校验应 < 2s，实际 ${importMs.toFixed(1)}ms`)
  check.ok(mergeMedian < 200, `5000 人归并中位耗时应 < 200ms，实际 ${mergeMedian.toFixed(1)}ms`)

  check.eq(chain1.summary.totals.validRows, COUNT, '有效人数')
  check.eq(chain1.summary.totals.specialQty, COUNT / 40, '特殊单列（每 40 人 1 个 PLUS）')
  check.eq(chain1.summary.totals.regularQty, COUNT - COUNT / 40, '常规档')
  check.eq(chain1.summary.conserved, true, '5000 人守恒成立')

  // —— 第二遍：同一份输入，从 CSV 重新走整条链 ——
  const project2 = makeProject({ name: '大批量回归', ruleVersion: rule.version, batches: ['春装', '秋装'] })
  importInto(project2, csvText)
  const chain2 = runChain(project2, rule)

  check.eq(chain2.orderCsv, chain1.orderCsv, '两次运行：下单汇总表 CSV 逐字节一致')
  check.eq(chain2.detailCsv, chain1.detailCsv, '两次运行：量体明细 CSV 逐字节一致')
  check.deepEq(
    sortedHistogram(summaryHistogram(chain2.summary)),
    sortedHistogram(summaryHistogram(chain1.summary)),
    '两次运行：分档汇总逐行一致'
  )
  check.deepEq(chain2.summary.totals, chain1.summary.totals, '两次运行：总计数一致')

  // XLSX 逐格一致（ZIP 头含打包时间戳，不比字节，比逐格内容）
  const orderBook2 = await readXlsxBlob(buildXlsxBlob(chain2.orderXlsxSheets))
  const orderBook1 = await readXlsxBlob(orderBlob1)
  check.eq(sheetSignature(orderBook2[0].rows), sheetSignature(orderBook1[0].rows), '两次运行：下单表 XLSX 逐格一致')
  const detailBook2 = await readXlsxBlob(buildXlsxBlob(chain2.detailXlsxSheets))
  const detailBook1 = await readXlsxBlob(detailBlob1)
  check.eq(sheetSignature(detailBook2[0].rows), sheetSignature(detailBook1[0].rows), '两次运行：明细 XLSX 逐格一致')

  // 归并幂等：同一项目再归并一次，汇总不变
  const chain3 = runChain(project1, rule)
  check.deepEq(chain3.summary.allRows, chain1.summary.allRows, '同一项目重复归并：分档汇总不变（幂等）')
})

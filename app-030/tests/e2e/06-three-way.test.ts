/**
 * 链路第 5~7 步：同一份数据在三处呈现必须一致。
 *   处 1  页面小计（SummaryView 渲染的 buildSummary 输出）
 *   处 2  下单汇总表文件（buildOrderSheet → CSV / XLSX，含按班级小计）
 *   处 3  量体明细文件（detailRows，含特殊体型清单）与打印稿（orderSheet.items + 守恒等式）
 *
 * 基准决策：以页面汇总为唯一事实源，导出物为被测对象；
 * 同时用 independentHistogram（不经过 buildSummary，直接从 persons 重算）双记账，
 * 防止「页面算错、导出跟着错」的系统性偏差。详见 tests/e2e/README.md。
 */
import { test } from 'node:test'
import { makeCheck, who } from './helpers/check'
import { addPerson, makeProject, mergeableInput } from './helpers/factory'
import {
  FIXED_GENERATED_AT,
  independentHistogram,
  runChain,
  sortedHistogram,
  summaryHistogram
} from './helpers/chain'
import { BUILTIN_RULES, specialFlagLabel } from '../../src/logic/sizeRules'
import { DETAIL_HEADER, genderLabel, personStatusLabel, summaryRowLabel } from '../../src/logic/exporter'
import { parseDelimitedText } from '../../src/logic/csv'
import { buildXlsxBlob } from '../../src/logic/xlsx'
import { expectRows, readXlsxBlob, sheetSignature } from './helpers/xlsxReader'
import type { Project } from '../../src/logic/types'

const rule = BUILTIN_RULES.find((item) => item.version === 'v1.0.0')!

const SPECIALS = new Map([[7, 'PLUS'], [18, 'PLUS'], [29, 'TALL']])
const OVERRIDES = new Map([
  [3, { sizeCode: '175/92B', by: '复核员甲', reason: '肩宽实测放宽' }],
  [40, { sizeCode: '165/96C', by: '复核员乙', reason: '现场复测调整' }]
])

/** 62 行夹具：60 有效（3 特殊、2 覆写）+ 1 无效 + 1 重复排除 */
function buildProject(): Project {
  const project = makeProject({ ruleVersion: rule.version, batches: ['春装', '秋装'] })
  for (let i = 0; i < 60; i += 1) {
    addPerson(
      project,
      rule,
      mergeableInput(rule, i, {
        orgUnit: `高一(${(i % 3) + 1})班`,
        ...(SPECIALS.has(i) ? { specialFlag: SPECIALS.get(i) } : {})
      })
    )
  }
  addPerson(project, rule, { name: '无效甲', orgUnit: '高一(2)班', heightCm: 80, chestCm: 60, waistCm: 50, sourceRow: 61 })
  addPerson(project, rule, { name: '重复甲', orgUnit: '高一(3)班', heightCm: 170, chestCm: 88, waistCm: 72, sourceRow: 62 })
  return project
}

function prepareChain() {
  const project = buildProject()
  runChain(project, rule) // 首轮归并，让 result 就位
  OVERRIDES.forEach((override, index) => {
    const person = project.persons[index]
    person.result = {
      sizeCode: override.sizeCode,
      ruleSizeCode: person.result?.ruleSizeCode ?? '',
      fit: person.result?.fit ?? null,
      ruleVersion: rule.version,
      manualOverride: { sizeCode: override.sizeCode, by: override.by, reason: override.reason, at: 1700000000000 }
    }
  })
  // 重复甲：人工确认为重复行并排除
  const dup = project.persons[61]
  dup.status = 'duplicate'
  dup.statusReason = '确认为重复行并排除'
  dup.result = null
  return runChain(project, rule)
}

test('一致性：页面汇总 与 独立直方图（不经过 buildSummary 的双记账）', () => {
  const check = makeCheck('页面小计')
  const chain = prepareChain()
  const independent = independentHistogram(chain.project)

  check.eq(independent.valid, 60, '独立复核：有效人数')
  check.eq(independent.unmerged, 0, '独立复核：无未归并')
  check.deepEq(
    sortedHistogram(independent.entries),
    sortedHistogram(summaryHistogram(chain.summary)),
    '独立直方图 与 页面分档汇总 完全一致'
  )
  check.eq(chain.summary.totals.validRows, 60, '页面：有效人数')
  check.eq(chain.summary.totals.regularQty, 57, '页面：常规档（60 − 3 特殊）')
  check.eq(chain.summary.totals.specialQty, 3, '页面：特殊单列')
  check.eq(chain.summary.totals.overrideCount, 2, '页面：人工覆写 2 条')
  check.eq(chain.summary.conserved, true, '页面：守恒通过')
})

test('一致性：下单汇总表 逐项等于页面汇总', () => {
  const check = makeCheck('下单汇总表')
  const chain = prepareChain()
  const { summary, orderSheet, orderRows, orgRows } = chain

  check.eq(orderSheet.items.length, summary.allRows.length, '下单表行数 = 页面号型档数')
  summary.allRows.forEach((row, index) => {
    const item = orderSheet.items[index]
    check.eq(item.sizeLabel, summaryRowLabel(rule, row), `第 ${index + 1} 行号型标签`)
    check.eq(item.qty, row.qty, `第 ${index + 1} 行数量（${item.sizeLabel}）`)
    check.eq(item.gender, genderLabel(row.gender), `第 ${index + 1} 行性别`)
    check.eq(item.kind, row.isSpecial ? '特殊单列' : '常规档', `第 ${index + 1} 行类型`)
  })
  check.eq(orderSheet.totalQty, summary.totals.accountedQty, '下单表总套数 = 页面已归账套数')
  check.eq(orderSheet.totalPeople, summary.totals.validRows, '下单表有效人数 = 页面有效人数')
  check.eq(
    orderSheet.items.reduce((sum, item) => sum + item.qty, 0),
    orderSheet.totalQty,
    '下单表各行数量之和 = 合计'
  )

  const meta = orderRows.slice(0, 6)
  check.deepEq(meta[0], ['项目名称', chain.project.name], '文件头：项目名')
  check.deepEq(meta[4], ['守恒校验', `${chain.conservation} → 通过`], '文件头：守恒等式与页面逐字一致')
  check.deepEq(orderRows[7], ['序号', '号型', '性别', '类型', '数量'], '下单表表头')
  const totalRow = orderRows[orderRows.length - 2]
  check.deepEq(totalRow, ['', '合计', '', '', orderSheet.totalQty], '下单表合计行')
  const peopleRow = orderRows[orderRows.length - 1]
  check.deepEq(peopleRow, ['', '有效人数', '', '', orderSheet.totalPeople], '下单表有效人数行')

  check.deepEq(orgRows[0], ['班级/车间', '序号', '号型', '性别', '类型', '数量'], '班级小计表头')
  const subtotals = orgRows.filter((row) => String(row[0]).endsWith(' 小计'))
  check.eq(subtotals.length, summary.byOrgUnit.length, '每个班级/车间各一行小计')
  check.eq(
    subtotals.reduce((sum, row) => sum + (row[5] as number), 0),
    summary.totals.accountedQty,
    '班级小计之和 = 页面已归账套数'
  )
  for (const group of summary.byOrgUnit) {
    const subtotal = subtotals.find((row) => row[0] === `${group.orgUnit} 小计`)!
    check.eq(subtotal[5], group.regularQty + group.specialQty, `${group.orgUnit} 小计 = 页面分组合计`)
  }
})

test('一致性：量体明细 逐人等于页面结果，且能反推出同一个分档汇总', () => {
  const check = makeCheck('量体明细')
  const chain = prepareChain()
  const { project, summary } = chain
  const rows = chain.detailRows

  check.deepEq(rows[0], DETAIL_HEADER, '明细表头')
  check.eq(rows.length - 1, project.persons.length, '明细行数 = 总人数（含无效与重复行，便于回贴核对）')

  project.persons.forEach((person, index) => {
    const row = rows[index + 1]
    check.eq(row[1], person.name, `第 ${index + 1} 行姓名`, who(person))
    check.eq(row[11], person.result?.sizeCode ?? '', `第 ${index + 1} 行生效号型`, who(person))
    check.eq(row[16], personStatusLabel(person), `第 ${index + 1} 行状态`, who(person))
  })

  // 从导出明细反推直方图（导出为被测对象），必须等于页面汇总
  const histogram = new Map<string, number>()
  for (const row of rows.slice(1)) {
    if (row[16] !== '有效') continue
    const key = row[15] !== '' ? `S|${row[15]}|${row[2]}` : `R|${row[11]}|${row[2]}`
    histogram.set(key, (histogram.get(key) ?? 0) + 1)
  }
  for (const row of summary.allRows) {
    const key = row.isSpecial
      ? `S|${specialFlagLabel(rule, row.sizeCode)}|${genderLabel(row.gender)}`
      : `R|${row.sizeCode}|${genderLabel(row.gender)}`
    check.eq(histogram.get(key) ?? 0, row.qty, `明细反推数量 = 页面数量（${key}）`)
    histogram.delete(key)
  }
  check.eq(histogram.size, 0, '明细反推不多不少，恰好覆盖页面全部号型档')

  const specialSheet = chain.specialRows
  check.eq(specialSheet.length - 1, summary.totals.specialPersonCount, '特殊体型清单条数 = 页面特殊人数')
})

test('一致性：CSV 文件内容 与 页面/下单表模型逐格相同', () => {
  const check = makeCheck('导出文件')
  const chain = prepareChain()

  const expectCsvRows = chain.orderRows
    .filter((row) => row.some((cell) => String(cell) !== ''))
    .map((row) => row.map((cell) => String(cell)))
  check.deepEq(parseDelimitedText(chain.orderCsv), expectCsvRows, '下单汇总表 CSV 逐格回读一致')

  const expectDetailRows = chain.detailRows
    .filter((row) => row.some((cell) => String(cell) !== ''))
    .map((row) => row.map((cell) => String(cell)))
  check.deepEq(parseDelimitedText(chain.detailCsv), expectDetailRows, '量体明细 CSV 逐格回读一致')

  const again = runChain(chain.project, rule)
  check.eq(again.orderCsv, chain.orderCsv, '同一输入两次导出：下单表 CSV 逐字节相同')
  check.eq(again.detailCsv, chain.detailCsv, '同一输入两次导出：明细 CSV 逐字节相同')
})

test('一致性：XLSX 文件 与 页面/下单表模型逐格相同（含数值类型）', async () => {
  const check = makeCheck('导出文件')
  const chain = prepareChain()

  const orderBook = await readXlsxBlob(buildXlsxBlob(chain.orderXlsxSheets))
  check.deepEq(orderBook.map((sheet) => sheet.name), ['下单汇总表', '按班级车间小计'], '下单工作簿的工作表')
  check.eq(sheetSignature(orderBook[0].rows), sheetSignature(expectRows(chain.orderRows)), '下单汇总表 XLSX 逐格一致')
  check.eq(sheetSignature(orderBook[1].rows), sheetSignature(expectRows(chain.orgRows)), '班级小计 XLSX 逐格一致')

  const detailBook = await readXlsxBlob(buildXlsxBlob(chain.detailXlsxSheets))
  check.deepEq(detailBook.map((sheet) => sheet.name), ['量体明细', '特殊体型清单'], '明细工作簿的工作表')
  check.eq(sheetSignature(detailBook[0].rows), sheetSignature(expectRows(chain.detailRows)), '量体明细 XLSX 逐格一致')
  check.eq(sheetSignature(detailBook[1].rows), sheetSignature(expectRows(chain.specialRows)), '特殊体型清单 XLSX 逐格一致')
})

test('一致性：打印稿 与 页面汇总同源（等式、行项、合计）', () => {
  const check = makeCheck('打印稿')
  const chain = prepareChain()
  // 打印预览渲染的就是 orderSheet.items 与 conservationText(summary)，这里锁定同源契约
  check.eq(chain.conservation, `常规 ${chain.summary.totals.regularQty} + 特殊 ${chain.summary.totals.specialQty} = 有效 ${chain.summary.totals.validRows} / 总录入 ${chain.summary.totals.totalRows}`, '打印稿守恒等式 = 页面等式')
  check.eq(
    chain.orderSheet.items.reduce((sum, item) => sum + item.qty, 0),
    chain.summary.totals.accountedQty,
    '打印稿行项合计 = 页面已归账套数'
  )
  check.eq(chain.orderSheet.totalPeople, chain.summary.totals.validRows, '打印稿有效人数 = 页面有效人数')
  check.eq(chain.orderSheet.meta[4].value, `${chain.conservation} → 通过`, '下单表文件头与打印稿共用同一等式文本')
  check.eq(FIXED_GENERATED_AT.getFullYear(), 2026, '夹具时间固定（保证两次运行可比较）')
})

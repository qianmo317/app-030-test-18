/**
 * 链路第 4 步：分档小计与守恒。
 * 规格书 §4.5 / §10：Σ常规档 + Σ特殊单列 = 有效人数；不守恒时不允许导出下单表，
 * 并逐行列出未归并的人。500 行含 3 条无效数据时等式成立；
 * 人为制造 1 条未归并行 → 导出被阻止并定位到行；处理后守恒恢复。
 */
import { test } from 'node:test'
import { makeCheck, who } from './helpers/check'
import { addPerson, makeProject, mergeableInput } from './helpers/factory'
import { runChain } from './helpers/chain'
import { BUILTIN_RULES } from '../../src/logic/sizeRules'
import type { Project } from '../../src/logic/types'

const rule = BUILTIN_RULES.find((item) => item.version === 'v1.0.0')!

const SPECIAL_INDICES = new Map([
  [5, 'PLUS'], [17, 'PLUS'], [29, 'TALL'], [41, 'PLUS'],
  [53, 'TALL'], [65, 'CUSTOM'], [77, 'PLUS'], [89, 'CUSTOM']
])

/**
 * 500 行夹具：497 有效（含 8 特殊）+ 3 无效。
 * withBroken=true 时，第 200 号人在录入时刻意让胸腰差落进型别空隙（11.5cm），
 * 走与真实录入相同的 analyzeDraft 校验路径，成为「未归并」行。
 */
function build500(withBroken = false): Project {
  const project = makeProject({ ruleVersion: rule.version, batches: ['春装', '秋装'] })
  for (let i = 0; i < 497; i += 1) {
    let input = mergeableInput(rule, i, SPECIAL_INDICES.has(i) ? { specialFlag: SPECIAL_INDICES.get(i) } : {})
    if (withBroken && i === 200) {
      input = mergeableInput(rule, i, { waistCm: (input.chestCm ?? 0) - 11.5 })
    }
    addPerson(project, rule, input)
  }
  // 3 条无效数据：身高超范围 / 胸围超范围 / 缺腰围
  addPerson(project, rule, { name: '无效甲', heightCm: 80, chestCm: 60, waistCm: 50, sourceRow: 498 })
  addPerson(project, rule, { name: '无效乙', heightCm: 170, chestCm: 30, waistCm: 25, sourceRow: 499 })
  addPerson(project, rule, { name: '无效丙', heightCm: 170, chestCm: 88, waistCm: null, sourceRow: 500 })
  return project
}

test('分档小计与守恒：500 行含 3 条无效，常规 + 特殊 = 有效人数', () => {
  const check = makeCheck('分档小计与守恒')
  const chain = runChain(build500(), rule)
  const { summary } = chain

  check.eq(summary.totals.totalRows, 500, '总录入行数')
  check.eq(summary.totals.invalidRows, 3, '无效行数')
  check.eq(summary.totals.validRows, 497, '有效人数')
  check.eq(summary.totals.regularQty, 489, '常规档套数（497 − 8 特殊）')
  check.eq(summary.totals.specialQty, 8, '特殊单列套数')
  check.eq(summary.totals.accountedQty, 497, '已归账套数')
  check.eq(summary.conserved, true, '守恒成立')
  check.eq(chain.conservation, '常规 489 + 特殊 8 = 有效 497 / 总录入 500', '守恒等式文本')
  check.eq(summary.unmerged.length, 0, '无未归并行')

  const orgValid = summary.byOrgUnit.reduce((sum, group) => sum + group.validCount, 0)
  const orgInvalid = summary.byOrgUnit.reduce((sum, group) => sum + group.invalidCount, 0)
  const orgRegular = summary.byOrgUnit.reduce((sum, group) => sum + group.regularQty, 0)
  const orgSpecial = summary.byOrgUnit.reduce((sum, group) => sum + group.specialQty, 0)
  check.eq(orgValid, 497, '班级/车间小计：有效人数合计')
  check.eq(orgInvalid, 3, '班级/车间小计：无效行合计')
  check.eq(orgRegular, 489, '班级/车间小计：常规档合计')
  check.eq(orgSpecial, 8, '班级/车间小计：特殊单列合计')

  const batchRegular = summary.byBatch.reduce((sum, group) => sum + group.regularQty, 0)
  const batchSpecial = summary.byBatch.reduce((sum, group) => sum + group.specialQty, 0)
  check.eq(batchRegular, 489, '批次小计：常规档合计')
  check.eq(batchSpecial, 8, '批次小计：特殊单列合计')

  const rowSum = summary.allRows.reduce((sum, row) => sum + row.qty, 0)
  check.eq(rowSum, 497, '分档行数量之和 = 已归账套数')
})

test('分档小计与守恒：人为制造 1 条未归并 → 导出被阻止并定位到行，处理后恢复', () => {
  const check = makeCheck('分档小计与守恒')
  const project = build500(true)
  const target = project.persons[200]
  check.eq(target.specialFlag, null, '前提：目标行不是特殊体型', who(target))
  check.ok(target.anomaly.includes('diff_out_of_range'), '前提：录入时已标记胸腰差异常', who(target))

  const broken = runChain(project, rule)
  check.eq(broken.summary.conserved, false, '存在未归并行时守恒不成立')
  check.eq(broken.summary.unmerged.length, 1, '应恰好 1 行未归并')
  const diff = broken.summary.unmerged[0]
  check.eq(diff.personId, target.id, '未归并清单应定位到这个人', who(target))
  check.eq(diff.name, target.name, '未归并清单应给出姓名', who(target))
  check.eq(diff.sourceRow, target.sourceRow, '未归并清单应给出行号', who(target))
  check.match(diff.reason, /胸腰差不在型别区间/, '未归并原因')

  // 导出页闸门：blocked = !conserved（ExportView 同款判断）
  const exportBlocked = !broken.summary.conserved
  check.eq(exportBlocked, true, '不守恒 → 下单表导出被阻止')

  // 处理方式：标记特殊体型，单列进定制清单（不混入常规档）
  target.specialFlag = 'CUSTOM'
  const healed = runChain(project, rule)
  check.eq(healed.summary.conserved, true, '标记特殊体型后守恒恢复')
  check.eq(healed.summary.totals.specialQty, 9, '特殊单列 +1')
  check.eq(healed.summary.totals.regularQty, 488, '常规档 −1')
  check.eq(healed.summary.totals.accountedQty, 497, '总人数不变')
})

test('分档小计与守恒：重复行人工确认排除后守恒仍成立', () => {
  const check = makeCheck('分档小计与守恒')
  const project = build500()
  const target = project.persons[100]

  // 归并页「确认为重复行并排除」的路径
  target.status = 'duplicate'
  target.statusReason = '确认为重复行并排除'
  target.result = null

  const chain = runChain(project, rule)
  check.eq(chain.summary.totals.duplicateRows, 1, '重复行（已排除）计数')
  check.eq(chain.summary.totals.validRows, 496, '有效人数 −1')
  check.eq(chain.summary.totals.accountedQty, 496, '已归账套数同步 −1')
  check.eq(chain.summary.conserved, true, '排除重复行后守恒仍成立')
})

/**
 * 链路第 3.5 步：人工覆写 与 规则归并冲突时的判准。
 * 规格书 §8：覆写只改号型归属，不改人数；覆写后仍计入总数守恒。
 * 锁定的判准：
 * - 人数套数以「覆写后的生效号型」为准入桶，按规则归并的号型保留在 ruleSizeCode 供对比；
 * - 覆写后守恒等式必须仍然成立（覆写不改人数）；
 * - 覆写必须留痕（操作人 / 原因 / 时间），并体现在量体明细导出中；
 * - 重跑归并（幂等）不丢覆写；撤销覆写后回到规则结果。
 */
import { test } from 'node:test'
import { makeCheck, who } from './helpers/check'
import { addPerson, makeProject } from './helpers/factory'
import { runChain } from './helpers/chain'
import { BUILTIN_RULES, isSizeCodeValid, normalizeSizeCodeInput } from '../../src/logic/sizeRules'
import { DETAIL_HEADER } from '../../src/logic/exporter'
import type { Person, Project } from '../../src/logic/types'

const rule = BUILTIN_RULES.find((item) => item.version === 'v1.0.0')!

function buildProject(): Project {
  const project = makeProject({ ruleVersion: rule.version })
  // 张三、李四 按规则都归到 170/88A
  addPerson(project, rule, { name: '张三', gender: 'male', heightCm: 167.5, chestCm: 88, waistCm: 74, sourceRow: 1 })
  addPerson(project, rule, { name: '李四', gender: 'male', heightCm: 168, chestCm: 88, waistCm: 74, sourceRow: 2 })
  for (let i = 2; i < 10; i += 1) {
    const height = 155 + i * 2.5
    const chest = 88 + 4 * (i % 4)
    addPerson(project, rule, {
      name: `同学${String(i).padStart(2, '0')}`,
      gender: 'male',
      heightCm: height,
      chestCm: chest,
      waistCm: chest - 14,
      sourceRow: i + 1
    })
  }
  return project
}

/** 与 MergeView.submitOverride 相同的写入路径（含格式校验与留痕） */
function applyOverride(person: Person, sizeCode: string, by: string, reason: string): void {
  person.result = {
    sizeCode,
    ruleSizeCode: person.result?.ruleSizeCode ?? '',
    fit: person.result?.fit ?? null,
    ruleVersion: rule.version,
    manualOverride: { sizeCode, by, reason, at: 1700000000000 }
  }
}

/** 与 MergeView.revertOverride 相同的撤销路径 */
function revertOverride(person: Person): void {
  if (!person.result?.manualOverride) return
  person.result = {
    sizeCode: person.result.ruleSizeCode || person.result.sizeCode,
    ruleSizeCode: person.result.ruleSizeCode,
    fit: person.result.fit,
    ruleVersion: rule.version
  }
}

function bucketQty(project: Project, sizeCode: string): number {
  const summary = runChain(project, rule).summary
  return summary.regularRows.find((row) => row.sizeCode === sizeCode && row.gender === 'male')?.qty ?? 0
}

test('覆写：人数套数以覆写后的号型为准，守恒仍成立', () => {
  const check = makeCheck('覆写与守恒')
  const project = buildProject()

  const before = runChain(project, rule)
  check.eq(before.summary.totals.validRows, 10, '有效人数')
  check.eq(before.summary.totals.regularQty, 10, '常规档套数')
  check.eq(bucketQty(project, '170/88A'), 2, '规则归并：张三、李四都在 170/88A')

  const zhangsan = project.persons[0]
  check.eq(zhangsan.result?.sizeCode, '170/88A', '前提：张三按规则归并', who(zhangsan))
  applyOverride(zhangsan, '175/92B', '班主任李', '肩宽实测放宽')

  const after = runChain(project, rule)
  check.eq(after.summary.totals.overrideCount, 1, '人工覆写计数')
  check.eq(after.summary.totals.ruleResolvedCount, 9, '按规则归并计数（10 − 1）')
  check.eq(bucketQty(project, '175/92B'), 1, '覆写后张三计入 175/92B（以覆写为准）')
  check.eq(bucketQty(project, '170/88A'), 1, '170/88A 只剩李四（规则结果让位）')
  check.eq(after.summary.conserved, true, '覆写后守恒仍成立（覆写只改归属不改人数）')
  check.eq(after.summary.totals.accountedQty, 10, '总套数不变')

  const result = project.persons[0].result!
  check.eq(result.sizeCode, '175/92B', '生效号型 = 覆写值', who(zhangsan))
  check.eq(result.ruleSizeCode, '170/88A', '按规则归并的号型保留供对比', who(zhangsan))
  check.eq(result.manualOverride?.by, '班主任李', '覆写留痕：操作人', who(zhangsan))
  check.eq(result.manualOverride?.reason, '肩宽实测放宽', '覆写留痕：原因', who(zhangsan))
})

test('覆写：两人覆写到同一号型则合并计数；重跑归并不丢覆写；撤销回到规则结果', () => {
  const check = makeCheck('覆写与守恒')
  const project = buildProject()
  runChain(project, rule)

  applyOverride(project.persons[0], '175/92B', '班主任李', '肩宽实测放宽')
  applyOverride(project.persons[1], '175/92B', '班主任李', '同上')
  const merged = runChain(project, rule)
  check.eq(bucketQty(project, '175/92B'), 2, '两人覆写到同一号型：数量合并')
  check.eq(bucketQty(project, '170/88A'), 0, '170/88A 不再有桶')
  check.eq(merged.summary.conserved, true, '守恒成立')

  // 幂等：再跑一次归并，覆写不能丢、结果不能变
  const again = runChain(project, rule)
  check.deepEq(again.summary.allRows, merged.summary.allRows, '重跑归并后分档结果不变（幂等）')
  check.eq(again.summary.totals.overrideCount, 2, '重跑归并后覆写计数不变')

  revertOverride(project.persons[0])
  const reverted = runChain(project, rule)
  check.eq(project.persons[0].result?.sizeCode, '170/88A', '撤销覆写后回到规则结果', who(project.persons[0]))
  check.eq(reverted.summary.totals.overrideCount, 1, '覆写计数回落')
  check.eq(bucketQty(project, '170/88A'), 1, '170/88A 恢复 1 人')
  check.eq(reverted.summary.conserved, true, '撤销后守恒仍成立')
})

test('覆写：号型格式校验拦住非法输入', () => {
  const check = makeCheck('覆写与守恒')
  check.eq(isSizeCodeValid(rule, '170/88Z'), false, '型别 Z 非法，应拦住')
  check.eq(isSizeCodeValid(rule, '170-88A'), false, '分隔符非法，应拦住')
  check.eq(isSizeCodeValid(rule, '170/88'), false, '缺型别，应拦住')
  check.eq(isSizeCodeValid(rule, '170/88A'), true, '合法号型')
  check.eq(normalizeSizeCodeInput('170／88a'), '170/88A', '全角斜杠与小写型别应被规整')
  check.eq(isSizeCodeValid(rule, normalizeSizeCodeInput(' 175 / 92.5b ')), true, '空白与半厘米胸围的合法输入')
})

test('覆写：留痕进入量体明细导出（规则号型 vs 生效号型）', () => {
  const check = makeCheck('覆写与守恒')
  const project = buildProject()
  runChain(project, rule)
  applyOverride(project.persons[0], '175/92B', '班主任李', '肩宽实测放宽')
  const chain = runChain(project, rule)

  const header = chain.detailRows[0]
  check.deepEq(header, DETAIL_HEADER, '明细表头')
  const row = chain.detailRows.find((cells) => cells[1] === '张三')!
  check.eq(row[10], '170/88A', '明细列「规则号型」', who(project.persons[0]))
  check.eq(row[11], '175/92B', '明细列「生效号型」= 覆写值', who(project.persons[0]))
  check.eq(row[12], '是', '明细列「是否覆写」', who(project.persons[0]))
  check.eq(row[13], '班主任李', '明细列「覆写人」', who(project.persons[0]))
  check.eq(row[14], '肩宽实测放宽', '明细列「覆写原因」', who(project.persons[0]))

  check.match(chain.detailCsv, /班主任李/, '明细 CSV 含覆写人')
  check.match(chain.detailCsv, /肩宽实测放宽/, '明细 CSV 含覆写原因')
  check.match(chain.orderCsv, /175\/92B/, '下单汇总表 CSV 含覆写后的号型')
})

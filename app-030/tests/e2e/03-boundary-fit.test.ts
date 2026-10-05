/**
 * 链路第 3 步：档位与型别判定。
 * 关键诉求：落在两档中间的值，在「归上」与「就近」两种边界规则下必须得出不同结果——
 * 证不出差别就不算过（防呆：若有人把边界逻辑写死成一种，这里必然失败）。
 * 同时锁定：边界两侧、型别区间端点（闭区间）、区间空隙、男女不同标准、规则版本锁定。
 */
import { test } from 'node:test'
import { deepEqual } from 'node:assert/strict'
import { makeCheck } from './helpers/check'
import { addPerson, makeDraft, makeProject } from './helpers/factory'
import { runChain } from './helpers/chain'
import {
  BUILTIN_RULES,
  chestCodeUnits,
  heightCodeUnits,
  resolveFit,
  ruleByVersion
} from '../../src/logic/sizeRules'
import { analyzeDraft } from '../../src/logic/analyze'
import type { SizeRule } from '../../src/logic/types'

const roundUpRule = BUILTIN_RULES.find((item) => item.version === 'v1.0.0')!
const nearestRule: SizeRule = { ...roundUpRule, version: 'e2e-nearest', boundaryRule: 'nearest' }

test('档位判定：两档中间值在归上 / 就近下必须不同（可证伪）', () => {
  const check = makeCheck('档位与型别')
  // [输入cm, 归上期望, 就近期望] —— 全部来自规则参数（锚点 155 / 步长 5；胸围锚点 84 / 步长 4）
  const heights: [number, number, number][] = [
    [167.5, 170, 165],
    [182.5, 185, 180],
    [162.5, 165, 160]
  ]
  for (const [cm, up, nearest] of heights) {
    const upUnits = heightCodeUnits(roundUpRule, cm)
    const nearestUnits = heightCodeUnits(nearestRule, cm)
    check.eq(upUnits / 2, up, `身高 ${cm}cm 归上应为 ${up}`)
    check.eq(nearestUnits / 2, nearest, `身高 ${cm}cm 就近应为 ${nearest}`)
    check.notEq(upUnits, nearestUnits, `身高 ${cm}cm 在两种边界规则下必须得出不同档位（可证伪）`)
  }
  const chests: [number, number, number][] = [
    [86, 88, 84],
    [90, 92, 88]
  ]
  for (const [cm, up, nearest] of chests) {
    const upUnits = chestCodeUnits(roundUpRule, cm)
    const nearestUnits = chestCodeUnits(nearestRule, cm)
    check.eq(upUnits / 2, up, `胸围 ${cm}cm 归上应为 ${up}`)
    check.eq(nearestUnits / 2, nearest, `胸围 ${cm}cm 就近应为 ${nearest}`)
    check.notEq(upUnits, nearestUnits, `胸围 ${cm}cm 在两种边界规则下必须得出不同档位（可证伪）`)
  }
})

test('档位判定：边界两侧与正落档上的值两种规则一致', () => {
  const check = makeCheck('档位与型别')
  const cases: [number, number][] = [
    [167, 165],
    [168, 170],
    [155, 155],
    [140, 140],
    [215, 215]
  ]
  for (const [cm, expected] of cases) {
    check.eq(heightCodeUnits(roundUpRule, cm) / 2, expected, `身高 ${cm}cm 归上`)
    check.eq(heightCodeUnits(nearestRule, cm) / 2, expected, `身高 ${cm}cm 就近（与归上相同）`)
  }
  for (const cm of [84, 88, 92]) {
    check.eq(chestCodeUnits(roundUpRule, cm) / 2, cm, `胸围 ${cm}cm 正落档上（归上）`)
    check.eq(chestCodeUnits(nearestRule, cm) / 2, cm, `胸围 ${cm}cm 正落档上（就近）`)
  }
})

test('档位与型别：同一个人整链归并在两种边界规则下结论不同', () => {
  const check = makeCheck('档位与型别')
  const buildProject = () => {
    const project = makeProject({ ruleVersion: roundUpRule.version })
    // 全部踩在身高或胸围的分档中点上
    addPerson(project, roundUpRule, { name: '边界甲', gender: 'male', heightCm: 167.5, chestCm: 86, waistCm: 70, sourceRow: 1 })
    addPerson(project, roundUpRule, { name: '边界乙', gender: 'male', heightCm: 182.5, chestCm: 90, waistCm: 74, sourceRow: 2 })
    addPerson(project, roundUpRule, { name: '边界丙', gender: 'female', heightCm: 162.5, chestCm: 86, waistCm: 70, sourceRow: 3 })
    addPerson(project, roundUpRule, { name: '档上丁', gender: 'male', heightCm: 170, chestCm: 88, waistCm: 72, sourceRow: 4 })
    return project
  }

  const upChain = runChain(buildProject(), roundUpRule)
  const nearestChain = runChain(buildProject(), nearestRule)

  check.eq(upChain.project.persons[0].result?.sizeCode, '170/88A', '边界甲 167.5/86 归上')
  check.eq(nearestChain.project.persons[0].result?.sizeCode, '165/84A', '边界甲 167.5/86 就近')
  check.eq(upChain.project.persons[1].result?.sizeCode, '185/92A', '边界乙 182.5/90 归上')
  check.eq(nearestChain.project.persons[1].result?.sizeCode, '180/88A', '边界乙 182.5/90 就近')
  check.eq(upChain.project.persons[3].result?.sizeCode, nearestChain.project.persons[3].result?.sizeCode, '档上丁两种规则一致')

  check.notEq(upChain.orderCsv, nearestChain.orderCsv, '整链产物（下单汇总表 CSV）在两种边界规则下必须不同')
})

test('型别判定：区间端点为闭区间，区间空隙与负值不可归并', () => {
  const check = makeCheck('档位与型别')
  const maleHits: [number, string][] = [
    [17, 'Y'], [22, 'Y'], [16, 'A'], [12, 'A'], [11, 'B'], [7, 'B'], [6, 'C'], [2, 'C']
  ]
  for (const [diff, fit] of maleHits) {
    check.eq(resolveFit(roundUpRule, 'male', diff)?.fit ?? null, fit, `男 胸腰差 ${diff}cm`)
  }
  const maleMisses = [23, 22.5, 16.5, 11.5, 6.5, 1.5, 1, 0, -0.5]
  for (const diff of maleMisses) {
    check.eq(resolveFit(roundUpRule, 'male', diff), null, `男 胸腰差 ${diff}cm 不在任何区间（未归并）`)
  }
  const femaleHits: [number, string][] = [
    [19, 'Y'], [24, 'Y'], [14, 'A'], [18, 'A'], [13, 'B'], [9, 'B'], [8, 'C'], [4, 'C']
  ]
  for (const [diff, fit] of femaleHits) {
    check.eq(resolveFit(roundUpRule, 'female', diff)?.fit ?? null, fit, `女 胸腰差 ${diff}cm`)
  }
  const femaleMisses = [25, 18.5, 13.5, 8.5, 3.5, 3]
  for (const diff of femaleMisses) {
    check.eq(resolveFit(roundUpRule, 'female', diff), null, `女 胸腰差 ${diff}cm 不在任何区间（未归并）`)
  }
})

test('型别判定：男女不同标准，同一胸腰差结论不同', () => {
  const check = makeCheck('档位与型别')
  check.eq(resolveFit(roundUpRule, 'male', 13)?.fit, 'A', '男 胸腰差 13 → A')
  check.eq(resolveFit(roundUpRule, 'female', 13)?.fit, 'B', '女 胸腰差 13 → B')
  check.eq(resolveFit(roundUpRule, 'male', 17)?.fit, 'Y', '男 胸腰差 17 → Y')
  check.eq(resolveFit(roundUpRule, 'female', 17)?.fit, 'A', '女 胸腰差 17 → A')
})

test('型别判定：胸腰差为负 → 异常待确认且不可归并', () => {
  const check = makeCheck('档位与型别')
  const outcome = analyzeDraft(
    makeDraft({ name: '张录反', gender: 'male', heightCm: 170, chestCm: 70, waistCm: 88 }),
    roundUpRule
  )
  check.eq(outcome.canMerge, false, '胸腰差为负不可自动归并')
  check.ok(outcome.anomaly.includes('diff_out_of_range'), '应标记胸腰差异常')
  check.eq(outcome.status, 'active', '仍计入有效人数（待人工处理）')
})

test('规则版本：项目锁定旧版本，规则改版不改变既有结论', () => {
  const check = makeCheck('档位与型别')
  const v11 = BUILTIN_RULES.find((item) => item.version === 'v1.1.0')!
  // 女装胸腰差 19：v1.0.0 落在 Y(19~24)，v1.1.0 落在 A(14~19)
  check.eq(resolveFit(roundUpRule, 'female', 19)?.fit, 'Y', 'v1.0.0 女 胸腰差 19 → Y')
  check.eq(resolveFit(v11, 'female', 19)?.fit, 'A', 'v1.1.0 女 胸腰差 19 → A（区间已改版）')

  const rules = [v11, roundUpRule] // 规则列表里新版在前，模拟「规则已升级」
  const project = makeProject({ ruleVersion: 'v1.0.0' })
  addPerson(project, roundUpRule, { name: '版本生', gender: 'female', heightCm: 160, chestCm: 88, waistCm: 69, sourceRow: 1 })
  const lockedRule = ruleByVersion(rules, project.ruleVersion)
  const chain = runChain(project, lockedRule)
  check.eq(chain.project.persons[0].result?.fit, 'Y', '旧项目仍按 v1.0.0 解释（胸腰差 19 → Y）')
  check.eq(chain.summary.ruleVersion, 'v1.0.0', '汇总应标注实际使用的规则版本')

  const migrated = runChain(project, v11)
  check.eq(migrated.project.persons[0].result?.fit, 'A', '同一人按 v1.1.0 则为 A（证明差异真实存在）')
  deepEqual(project.ruleVersion, 'v1.0.0', '项目的锁定版本不随规则改版而变')
})

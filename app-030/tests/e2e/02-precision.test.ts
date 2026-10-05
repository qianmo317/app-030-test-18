/**
 * 链路第 2 步：半厘米归一。
 * 规格书 §8：身高 / 胸围 / 腰围按 0.5cm 存储，判定用「半厘米整数」比较，不用浮点相等。
 * 这里的断言分三层：
 * 1) 归一化：任何输入都落到 0.5 网格上，半厘米单位一律是整数；
 * 2) 浮点噪声免疫：同一真实值的不同浮点写法（含 0.1+0.2 式误差）归并结果相同；
 * 3) 档位对齐全域穷举：与「定义即正确」的暴力参考实现逐点一致（整数域，无浮点相等）。
 */
import { test } from 'node:test'
import { makeCheck } from './helpers/check'
import { mulberry32 } from './helpers/factory'
import { BUILTIN_RULES, alignToStep, buildSizeCode } from '../../src/logic/sizeRules'
import { chestWaistDiffCm, cmToHalfUnits, parseLengthCm, roundToHalfCm } from '../../src/logic/precision'
import type { BoundaryRule } from '../../src/logic/types'

const rule = BUILTIN_RULES.find((item) => item.version === 'v1.0.0')!

/** 参考实现：按定义暴力找最近档位，半数按边界规则定向。慢，但显然正确。 */
function referenceAlign(units: number, anchor: number, step: number, boundary: BoundaryRule): number {
  let best = anchor
  let bestDist = Infinity
  for (let candidate = anchor - 200 * step; candidate <= anchor + 200 * step; candidate += step) {
    const dist = Math.abs(candidate - units)
    if (
      dist < bestDist ||
      (dist === bestDist && (boundary === 'round_up' ? candidate > best : candidate < best))
    ) {
      best = candidate
      bestDist = dist
    }
  }
  return best
}

test('半厘米归一：输入一律落到 0.5 网格', () => {
  const check = makeCheck('半厘米归一')
  const cases: [number, number][] = [
    [162.24, 162],
    [162.25, 162.5],
    [162.26, 162.5],
    [162.74, 162.5],
    [162.75, 163],
    [167.5, 167.5],
    [170, 170]
  ]
  for (const [input, expected] of cases) {
    check.eq(roundToHalfCm(input), expected, `roundToHalfCm(${input})`)
  }

  check.eq(parseLengthCm('167.5cm'), 167.5, '带单位文本解析')
  check.eq(parseLengthCm('168厘米'), 168, '中文单位解析')
  check.eq(parseLengthCm(' 170.5 '), 170.5, '空白容忍')
  check.eq(parseLengthCm('abc'), null, '非数字应解析失败')
  check.eq(parseLengthCm(''), null, '空串应解析失败')
  check.eq(parseLengthCm('-'), null, '裸负号应解析失败')
  check.eq(parseLengthCm(88.26), 88.5, '数值输入同样归一到网格')
})

test('半厘米归一：半厘米单位一律是整数（判定的比较对象）', () => {
  const check = makeCheck('半厘米归一')
  const random = mulberry32(20261005)
  for (let i = 0; i < 1000; i += 1) {
    const value = 100 + random() * 120
    const units = cmToHalfUnits(value)
    check.ok(Number.isInteger(units), `cmToHalfUnits(${value}) 必须是整数，实际 ${units}`)
    check.eq(units, cmToHalfUnits(roundToHalfCm(value)), `归一前后单位一致（${value}）`)
  }
  check.eq(cmToHalfUnits(167.5), 335, '167.5cm ↔ 335 个半厘米')
})

test('半厘米归一：浮点噪声不改变判定（不用浮点相等）', () => {
  const check = makeCheck('半厘米归一')
  check.notEq(0.1 + 0.2, 0.3, '前提：0.1+0.2 在浮点下确实不等于 0.3（尾差真实存在）')
  check.eq(cmToHalfUnits(0.1 + 0.2), cmToHalfUnits(0.3), '半厘米整数比较吸收浮点尾差')

  // 边界值 167.5 的两种浮点写法：都不是字面 167.5，但都必须归到同一个半厘米整数。
  // 若实现用浮点相等（h === 167.5）识别边界，这两种写法会漏判——这里正是要堵这个洞。
  const below = 167.5 - 1e-12
  const above = 167.5 + 1e-12
  check.notEq(below, 167.5, '前提：边界下方的浮点写法不等于 167.5')
  check.notEq(above, 167.5, '前提：边界上方的浮点写法不等于 167.5')
  check.eq(cmToHalfUnits(below), 335, '边界下方写法归到 335（=167.5cm 的半厘米整数）')
  check.eq(cmToHalfUnits(above), 335, '边界上方写法归到 335')

  const reference = buildSizeCode(rule, 'male', 167.5, 88, 72)
  check.deepEq(buildSizeCode(rule, 'male', below, 88, 72), reference, '边界下方写法的归并结果与 167.5 一致')
  check.deepEq(buildSizeCode(rule, 'male', above, 88, 72), reference, '边界上方写法的归并结果与 167.5 一致')
})

test('半厘米归一：胸腰差用整数相减，结果精确落在 0.5 网格', () => {
  const check = makeCheck('半厘米归一')
  check.eq(chestWaistDiffCm(88.5, 72.5), 16, '胸腰差精确等于 16（=== 而非约等于）')
  check.eq(chestWaistDiffCm(90, 73.5), 16.5, '胸腰差精确等于 16.5')
  const random = mulberry32(770311)
  for (let i = 0; i < 1000; i += 1) {
    const chest = Math.round((60 + random() * 80) * 2) / 2
    const waist = Math.round((40 + random() * 60) * 2) / 2
    const diff = chestWaistDiffCm(chest, waist)
    check.ok(Number.isInteger(diff * 2), `胸腰差 ${diff} 必须是 0.5 的整数倍`)
  }
})

test('半厘米归一：档位对齐全域穷举，与暴力参考实现逐点一致', () => {
  const check = makeCheck('半厘米归一')
  const boundaries: BoundaryRule[] = ['round_up', 'nearest']
  // 身高档：锚点 155cm(310)，步长 5cm(10)，穷举 100cm~250cm 的每一个半厘米
  for (const boundary of boundaries) {
    for (let units = 200; units <= 500; units += 1) {
      const actual = alignToStep(units, 310, 10, boundary)
      const expected = referenceAlign(units, 310, 10, boundary)
      check.eq(actual, expected, `身高档 units=${units}（${units / 2}cm）boundary=${boundary}`)
    }
    // 胸围档：锚点 84cm(168)，步长 4cm(8)，穷举 50cm~150cm
    for (let units = 100; units <= 300; units += 1) {
      const actual = alignToStep(units, 168, 8, boundary)
      const expected = referenceAlign(units, 168, 8, boundary)
      check.eq(actual, expected, `胸围档 units=${units}（${units / 2}cm）boundary=${boundary}`)
    }
  }
})

/**
 * 用例组 3：人工覆写与规则归并冲突时，人数 / 套数以谁为准，覆写后守恒是否成立。
 *
 * 判准（与 MergeView 提交路径一致）：
 *  - 人数永远以有效人数为准：覆写只改号型归属，不增删一个人
 *  - 套数的「按规则」口径看 ruleSizeCode；「实际下单」口径看生效 sizeCode（覆写后）
 *  - 汇总 / 下单 / 打印一律按生效口径；报告同时给出「按规则 N + 覆写 M」
 *  - 覆写必须留痕（号型 / 操作人 / 原因齐全，格式合法），否则入口拒绝
 */
import { isSizeCodeValid, normalizeSizeCodeInput } from '../src/logic/sizeRules'
import { normalizeProject } from '../src/logic/migrate'
import {
  RULE_V1,
  applyManualOverride,
  assert,
  detailRowByName,
  enterManually,
  makeProject,
  orderDataRows,
  pageOrderView,
  printOrderView,
  runPipeline,
  test
} from './helpers'

test('覆写-1 合法覆写只挪套数不挪人：人数守恒、规则口径与生效口径同时可查', () => {
  const pj = makeProject('覆写项目', RULE_V1)
  const a = enterManually(pj, RULE_V1, { name: '覆甲', gender: 'male', orgUnit: '一班', heightCm: 170, chestCm: 88, waistCm: 72 }) // 170/88A
  const b = enterManually(pj, RULE_V1, { name: '覆乙', gender: 'male', orgUnit: '一班', heightCm: 170, chestCm: 88, waistCm: 72 }) // 170/88A
  const c = enterManually(pj, RULE_V1, { name: '覆丙', gender: 'male', orgUnit: '一班', heightCm: 175, chestCm: 96, waistCm: 80 }) // 175/96A? diff16→A, h175 c96 → 175/96A

  const before = runPipeline(pj, RULE_V1)
  assert.equal(before.summary.totals.validRows, 3, '覆写前：有效 3 人')
  assert.equal(before.summary.allRows.find((r) => r.sizeCode === '170/88A' && r.gender === 'male')?.qty, 2, '覆写前：170/88A 男 2 套')

  // 把覆甲从 170/88A 覆写到 175/92B（现场试穿后改码）
  applyManualOverride(a, RULE_V1, '175/92B', '班主任李老师', '试穿偏紧，升一档胸围换 B 型')
  const after = runPipeline(pj, RULE_V1)

  // —— 人数口径不变 ——
  assert.equal(after.summary.totals.validRows, 3, '覆写后：有效人数仍是 3（人没多没少）')
  assert.equal(after.summary.totals.accountedQty, 3, '覆写后：总套数仍是 3')
  assert.equal(after.summary.conserved, true, '覆写后：守恒成立')
  assert.equal(after.summary.totals.overrideCount, 1, '覆写后：报告显示人工覆写 1 条')
  assert.equal(after.summary.totals.ruleResolvedCount, 2, '覆写后：按规则归并 2 条')

  // —— 套数口径：生效（下单）看 sizeCode；规则（对照）看 ruleSizeCode ——
  assert.equal(after.summary.allRows.find((r) => r.sizeCode === '170/88A' && r.gender === 'male')?.qty, 1, '生效口径：170/88A 只剩 1 套（覆乙）')
  assert.equal(after.summary.allRows.find((r) => r.sizeCode === '175/92B' && r.gender === 'male')?.qty, 1, '生效口径：175/92B 出现 1 套（覆甲覆写值）')
  assert.equal(a.result?.sizeCode, '175/92B', '本人：生效号型=覆写值')
  assert.equal(a.result?.ruleSizeCode, '170/88A', '本人：规则号型仍留痕=170/88A')
  assert.equal(b.result?.sizeCode, '170/88A', '未覆写的覆乙不受影响')

  // 三处呈现都按生效口径
  const page = pageOrderView(after.summary)
  const printed = printOrderView(after.ctx)
  const exported = orderDataRows(after.orderRows)
  for (const view of page) {
    const printItem = printed.find((item) => item.label === view.code && item.gender === view.gender)
    assert.ok(printItem, `三处一致：${view.code} 打印稿缺失`)
    assert.equal(printItem.qty, view.qty, `三处一致：${view.code} 打印稿数量与页面不符`)
    const fileItem = exported.find((item) => item.label === view.code && item.gender === view.gender)
    assert.ok(fileItem, `三处一致：${view.code} 导出缺失`)
    assert.equal(fileItem.qty, view.qty, `三处一致：${view.code} 导出数量与页面不符`)
  }

  // 量体明细同时带两列 + 覆写留痕
  const line = detailRowByName(after.detail, '覆甲')
  assert.equal(line['规则号型'], '170/88A', '量体明细：覆甲规则号型列=170/88A（对照口径）')
  assert.equal(line['生效号型'], '175/92B', '量体明细：覆甲生效号型列=175/92B（下单口径）')
  assert.equal(line['是否覆写'], '是', '量体明细：覆甲标记为已覆写')
  assert.equal(line['覆写人'], '班主任李老师', '量体明细：覆写操作人留痕')
  assert.match(String(line['覆写原因']), /试穿偏紧/, '量体明细：覆写原因留痕')

  // 跑两次归并幂等：覆写不丢、规则列不乱
  runPipeline(pj, RULE_V1)
  assert.equal(a.result?.manualOverride?.sizeCode, '175/92B', '幂等：重复归并后覆写仍在')
  assert.equal(a.result?.ruleSizeCode, '170/88A', '幂等：重复归并后规则号型仍为 170/88A')

  // 未参与覆写的第三人始终按规则：175/96A（diff16→A），桶里就这一套
  assert.equal(c.result?.sizeCode, '175/96A', '未覆写的覆丙保持规则号型 175/96A')
  assert.equal(c.result?.manualOverride, undefined, '未覆写的覆丙无留痕')
})

test('覆写-2 覆写到与规则冲突的合法号型，守恒仍成立且差异可逐人解释', () => {
  const pj = makeProject('冲突覆写', RULE_V1)
  // 两个人规则都判 170/88A，把其中一人覆写到规则根本不会产生的 165/100C
  const x = enterManually(pj, RULE_V1, { name: '冲甲', gender: 'male', orgUnit: '一班', heightCm: 170, chestCm: 88, waistCm: 72 })
  enterManually(pj, RULE_V1, { name: '冲乙', gender: 'male', orgUnit: '一班', heightCm: 170, chestCm: 88, waistCm: 72 })
  applyManualOverride(x, RULE_V1, '165/100C', '厂方业务员', '客户体型特殊，按实测定制码')
  const pipe = runPipeline(pj, RULE_V1)

  assert.equal(pipe.summary.conserved, true, '冲突覆写：2 人 2 套，守恒成立（覆写负责把他钉进某个桶）')
  assert.equal(pipe.summary.allRows.find((r) => r.sizeCode === '170/88A' && r.gender === 'male')?.qty, 1, '冲突覆写：170/88A 余 1')
  assert.equal(pipe.summary.allRows.find((r) => r.sizeCode === '165/100C' && r.gender === 'male')?.qty, 1, '冲突覆写：165/100C 出现 1（规则永远不会产出这个组合）')
  // 规则口径重算时：170/88A 的「按规则」人数仍是 2，下单口径是 1 —— 两个口径都要拿得到
  const ruleTally = new Map<string, number>()
  for (const person of pj.persons) {
    if (person.status !== 'active') continue
    const code = person.result?.ruleSizeCode
    if (code) ruleTally.set(code, (ruleTally.get(code) ?? 0) + 1)
  }
  assert.equal(ruleTally.get('170/88A'), 2, '对照口径：按规则 170/88A 仍是 2 人；与下单口径的差 1 正是覆写留痕条数')
})

test('覆写-3 无效覆写在入口被拦住（格式 / 留痕缺失）', () => {
  const pj = makeProject('非法覆写', RULE_V1)
  const p = enterManually(pj, RULE_V1, { name: '拦甲', gender: 'male', orgUnit: '一班', heightCm: 170, chestCm: 88, waistCm: 72 })
  runPipeline(pj, RULE_V1)

  // 与 MergeView.submitOverride 相同的校验顺序：格式 → 原因 → 操作人
  assert.equal(isSizeCodeValid(RULE_V1, normalizeSizeCodeInput('170-88A')), false, '入口拦截：170-88A 格式非法')
  assert.equal(isSizeCodeValid(RULE_V1, normalizeSizeCodeInput('170/88X')), false, '入口拦截：型别 X 非法')
  assert.equal(isSizeCodeValid(RULE_V1, normalizeSizeCodeInput('170/88.2A')), false, '入口拦截：胸围 88.2 不是 4cm 档位的半整数表达')
  assert.equal(isSizeCodeValid(RULE_V1, normalizeSizeCodeInput('170/88AA')), false, '入口拦截：多余型别字符非法')
  assert.equal(isSizeCodeValid(RULE_V1, normalizeSizeCodeInput('170/88a')), true, '入口放行：小写 a 归一后合法')

  // 模拟提交前校验（与 MergeView.submitOverride 的三道 return 同构）：
  // 格式非法、原因空、操作人空，任一不满足都不得写 result
  const formOk = { code: '175/92B', by: '李老师', reason: '试穿紧' }
  const canSubmit = (form: { code: string; by: string; reason: string }) =>
    isSizeCodeValid(RULE_V1, normalizeSizeCodeInput(form.code)) &&
    form.reason.trim() !== '' &&
    form.by.trim() !== ''
  assert.equal(canSubmit(formOk), true, '提交校验：合法表单可提交')
  assert.equal(canSubmit({ ...formOk, code: '170/88X' }), false, '提交校验：号型非法 → 拒绝')
  assert.equal(canSubmit({ ...formOk, reason: '   ' }), false, '提交校验：原因为空 → 拒绝（覆写必须留痕）')
  assert.equal(canSubmit({ ...formOk, by: '' }), false, '提交校验：操作人为空 → 拒绝')

  // 关键不变量：校验不过时 result 必须仍是规则值（页面上即 return，什么都不写）
  assert.equal(p.result?.sizeCode, '170/88A', '拦截后：未写入覆写，生效号型维持规则结果')
  assert.equal(p.result?.manualOverride, undefined, '拦截后：没有覆写留痕')
  const pipe = runPipeline(pj, RULE_V1)
  assert.equal(pipe.summary.totals.overrideCount, 0, '拦截后：覆写计数为 0')
  assert.equal(pipe.summary.conserved, true, '拦截后：守恒不受影响')
})

test('覆写-4 旧存档里结构损坏的覆写：剥离留痕、回落规则，不允许坏覆写决定套数', () => {
  // 直接构造一个「旧版本写出的坏覆写」：有 manualOverride 但缺 by/reason
  const pj = makeProject('坏覆写旧档', RULE_V1)
  const person = enterManually(pj, RULE_V1, { name: '旧档覆写人', gender: 'male', orgUnit: '一班', heightCm: 170, chestCm: 88, waistCm: 72 })
  runPipeline(pj, RULE_V1)
  person.result = {
    sizeCode: '185/104C',
    ruleSizeCode: '170/88A',
    fit: 'A',
    ruleVersion: 'v1.0.0',
    manualOverride: { sizeCode: '185/104C', by: '', reason: '', at: 0 } as never
  }

  // 走旧档兼容归一（与 initStore 打开旧项目时同一入口）
  const migrated = normalizeProject(JSON.parse(JSON.stringify(pj)), [RULE_V1])
  const mPerson = migrated.persons.find((item) => item.name === '旧档覆写人')!
  assert.equal(mPerson.result?.manualOverride, undefined, '旧档兼容：缺操作人/原因的坏覆写必须被剥离')
  assert.equal(mPerson.result?.sizeCode, '185/104C', '旧档兼容：剥离后保留存档生效号型，等待重新归并（不丢数据）')

  // 重新归并后彻底回落规则口径
  const pipe = runPipeline(migrated, RULE_V1)
  assert.equal(mPerson.result?.sizeCode, '170/88A', '重新归并：坏覆写不影响套数，生效号型回落规则 170/88A')
  assert.equal(pipe.summary.totals.overrideCount, 0, '重新归并：覆写计数 0')
  assert.equal(pipe.summary.conserved, true, '重新归并：守恒成立')
})

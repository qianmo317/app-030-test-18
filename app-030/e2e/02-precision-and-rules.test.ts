/**
 * 用例组 2：半厘米归一 + 档位 / 型别判定的技术红线。
 *  - 半厘米的量一律整数比较：构造浮点误差输入（0.1+0.2、169.9999999 之类），结果只能由半厘米整数决定
 *  - 边界取整必须能被证伪：同一输入在 round_up 与 nearest 下必须得出不同号型，
 *    证不出差别（实现退化成 Math.round）本组即失败
 *  - 区间端点闭区间、胸腰差负/缺失、版本差异全部钉到具体的人
 */
import { alignToStep, buildSizeCode, resolveFit } from '../src/logic/sizeRules'
import { cmToHalfUnits, chestWaistDiffCm, parseLengthCm, roundToHalfCm } from '../src/logic/precision'
import { RULE_V1, RULE_V1_NEAREST, RULE_V1_1, enterManually, makeProject, runPipeline, test, assert } from './helpers'

test('精度-1 半厘米值统一走整数比较，浮点表示不同不允许改变结论', () => {
  // 0.1+0.2 在浮点下不等于 0.3，但归一半厘米后必须与 0.3 同结论
  assert.notEqual(0.1 + 0.2, 0.3, '前置：浮点误差客观存在（0.1+0.2≠0.3）')
  assert.equal(roundToHalfCm(0.1 + 0.2), 0.5, '归一：0.30000000000000004 归一半厘米=0.5')
  assert.equal(cmToHalfUnits(0.1 + 0.2), cmToHalfUnits(0.3), '整数比较：0.1+0.2 与 0.3 的半厘米整数相等')
  assert.equal(cmToHalfUnits(167.5), 335, '整数比较：167.5cm=335 个半厘米')

  // 167.4999999999 与 167.5 只有一个 ULP 级差距：二者必须落到同一半厘米整数
  assert.equal(cmToHalfUnits(167.4999999999), 335, '整数比较：167.4999999999 四舍五入到半厘米=335')
  assert.equal(cmToHalfUnits(167.5000000001), 335, '整数比较：167.5000000001=335')
  // 真正跨半厘米边界的值必须被区分：167.2 归一→167 → 334，区别于 167.5→335
  assert.equal(cmToHalfUnits(167.2), 334, '整数比较：167.2→334')
  assert.notEqual(cmToHalfUnits(167.2), cmToHalfUnits(167.5), '整数比较：167.2→334 ≠ 167.5→335')

  // 胸腰差用半厘米整数相减：88.0-72.5 与直接浮点减法不同表示也必须一致
  const diffFloat = 88 - 72.5
  assert.equal(chestWaistDiffCm(88, 72.5), 15.5, '胸腰差：88−72.5=15.5（整数相减换算）')
  assert.equal(cmToHalfUnits(chestWaistDiffCm(88, 72.5)), cmToHalfUnits(diffFloat), '胸腰差：两种表示的半厘米整数相等')

  // 录入解析："167.50" 与 167.5 同档；"167.6" 归一半厘米=167.5（就近）
  assert.equal(parseLengthCm('167.50'), 167.5, '解析：字符串 167.50→167.5')
  assert.equal(parseLengthCm(167.6), 167.5, '解析：167.6 按半厘米精度归一=167.5')
})

test('精度-2 边界取整可证伪：167.5 在 round_up / nearest 下必须得出不同号型', () => {
  // 直接对齐函数层面的证伪
  const anchor = cmToHalfUnits(RULE_V1.heightAnchor)
  const step = cmToHalfUnits(RULE_V1.heightStepCm)
  const units = cmToHalfUnits(167.5)
  const up = alignToStep(units, anchor, step, 'round_up')
  const near = alignToStep(units, anchor, step, 'nearest')
  assert.notEqual(up, near, '边界证伪：167.5 两种边界规则必须得到不同档位（335 半厘米，恰在两档正中）')
  assert.equal(up / 2, 170, '边界归上：167.5→170')
  assert.equal(near / 2, 165, '就近归下：167.5→165')

  // 182.5 同样落在两档正中
  const units182 = cmToHalfUnits(182.5)
  assert.equal(alignToStep(units182, anchor, step, 'round_up') / 2, 185, '边界归上：182.5→185')
  assert.equal(alignToStep(units182, anchor, step, 'nearest') / 2, 180, '就近归下：182.5→180')

  // 边界两侧非正中值两种规则应一致（差异只允许出现在精确半档上）
  assert.equal(
    alignToStep(cmToHalfUnits(167), anchor, step, 'round_up'),
    alignToStep(cmToHalfUnits(167), anchor, step, 'nearest'),
    '边界两侧：167 在两种规则下同为 165'
  )
  assert.equal(
    alignToStep(cmToHalfUnits(168), anchor, step, 'round_up'),
    alignToStep(cmToHalfUnits(168), anchor, step, 'nearest'),
    '边界两侧：168 在两种规则下同为 170'
  )

  // 端到端证伪：同一两个人分别走 round_up 项目与 nearest 项目，号型必须不同
  const personInput = { name: '边界人', gender: 'male' as const, orgUnit: '一班', heightCm: 167.5, weightKg: 60, chestCm: 88, waistCm: 72 }
  const pjUp = makeProject('归上项目', RULE_V1)
  enterManually(pjUp, RULE_V1, personInput)
  const pjNear = makeProject('就近项目', RULE_V1_NEAREST)
  enterManually(pjNear, RULE_V1_NEAREST, personInput)

  const upPipe = runPipeline(pjUp, RULE_V1)
  const nearPipe = runPipeline(pjNear, RULE_V1_NEAREST)
  assert.equal(upPipe.summary.allRows.some((row) => row.sizeCode.startsWith('170/')), true, '端到端证伪：round_up 项目里边界人归到 170 档')
  assert.equal(nearPipe.summary.allRows.some((row) => row.sizeCode.startsWith('165/')), true, '端到端证伪：nearest 项目里边界人归到 165 档')
  assert.equal(
    upPipe.summary.allRows[0].sizeCode === nearPipe.summary.allRows[0].sizeCode,
    false,
    '端到端证伪：两种边界规则的导出首档号型不同——若相同说明边界实现退化成单一四舍五入'
  )
})

test('精度-3 回归哨兵：若有人把档位实现改成 Math.round 式浮点比较，本用例必须失败', () => {
  // 正确实现在半整数单位上判定；错误实现（Math.round(浮点/步长)）在 167.5 上也会给 170，
  // 所以差异必须靠 nearest 规则下「半档向下」这一支暴露：nearest(167.5)=165。
  const anchor = cmToHalfUnits(RULE_V1.heightAnchor)
  const step = cmToHalfUnits(RULE_V1.heightStepCm)
  const naiveMathRound = (cm: number) => RULE_V1.heightAnchor + RULE_V1.heightStepCm * Math.round((cm - RULE_V1.heightAnchor) / RULE_V1.heightStepCm)
  // naive 实现在 nearest 语义下无法表达「半档向下」，它永远给 170
  assert.equal(naiveMathRound(167.5), 170, '前置：朴素 Math.round 实现固定给 170')
  assert.equal(
    alignToStep(cmToHalfUnits(167.5), anchor, step, 'nearest') / 2,
    165,
    '哨兵：正确实现 nearest 下给 165，与朴素实现不同；此断言失败说明实现已退化为浮点四舍五入'
  )
})

test('判定-1 型别区间端点为闭区间，胸腰差恰好压端点时归属确定', () => {
  // 男装 v1.0.0：Y 17~22 / A 12~16 / B 7~11 / C 2~6
  assert.equal(resolveFit(RULE_V1, 'male', 17)?.fit, 'Y', '端点：男 diff=17 → Y（Y 下端点闭区间）')
  assert.equal(resolveFit(RULE_V1, 'male', 16)?.fit, 'A', '端点：男 diff=16 → A（A 上端点，与 Y 之间留 16.5/17 半厘米步进）')
  assert.equal(resolveFit(RULE_V1, 'male', 12)?.fit, 'A', '端点：男 diff=12 → A（A 下端点）')
  assert.equal(resolveFit(RULE_V1, 'male', 11)?.fit, 'B', '端点：男 diff=11 → B')
  assert.equal(resolveFit(RULE_V1, 'male', 7)?.fit, 'B', '端点：男 diff=7 → B')
  assert.equal(resolveFit(RULE_V1, 'male', 6)?.fit, 'C', '端点：男 diff=6 → C')
  assert.equal(resolveFit(RULE_V1, 'male', 2)?.fit, 'C', '端点：男 diff=2 → C（C 下端点）')
  // 半厘米步进允许的 16.5 不属任何区间 → null（未归并），不能乱归
  assert.equal(resolveFit(RULE_V1, 'male', 16.5), null, '间隙：男 diff=16.5 不在任何区间，返回 null（未归并）')
  assert.equal(resolveFit(RULE_V1, 'male', 1), null, '越界：男 diff=1 无型别')
})

test('判定-2 男女区间不同且规则改版只影响新项目（端到端钉到人）', () => {
  // diff=19：v1.0.0 女装 Y 19~24 是 Y；v1.1.0 女装 Y 20~25，19 → A 14~19
  assert.equal(resolveFit(RULE_V1, 'female', 19)?.fit, 'Y', '版本：v1.0.0 女装 diff=19 → Y（19~24）')
  assert.equal(resolveFit(RULE_V1_1, 'female', 19)?.fit, 'A', '版本：v1.1.0 女装 diff=19 → A（14~19），规则改版被钉住')
  assert.equal(resolveFit(RULE_V1, 'male', 19)?.fit, 'Y', '男装两版区间不变：diff=19 始终 Y')

  // 端到端：旧项目锁 v1.0.0，即使项目旁边存在 v1.1.0 规则，结论不变
  const pj = makeProject('旧项目', RULE_V1)
  const girl = enterManually(pj, RULE_V1, {
    name: '改版边界女', gender: 'female', orgUnit: '一班', heightCm: 165, chestCm: 88, waistCm: 69
  }) // diff=19
  const pipe = runPipeline(pj, RULE_V1)
  assert.equal(girl.result?.ruleVersion, 'v1.0.0', '版本锁定：旧项目的人始终按 v1.0.0 解释')
  assert.match(girl.result!.sizeCode, /Y$/, '版本锁定：diff19 女生在旧项目里仍是 Y 型')
  assert.equal(pipe.summary.ruleVersion, 'v1.0.0', '版本锁定：汇总表标注 v1.0.0')
})

test('判定-3 胸腰差为负 / 胸围缺失：拦在无效或未归并，且差异能定位到人', () => {
  const pj = makeProject('异常项目', RULE_V1)
  const reversed = enterManually(pj, RULE_V1, {
    name: '胸腰录反', gender: 'male', orgUnit: '一班', heightCm: 170, chestCm: 70, waistCm: 88
  }) // diff=-18
  const noChest = enterManually(pj, RULE_V1, {
    name: '缺胸围', gender: 'male', orgUnit: '一班', heightCm: 170, chestCm: null, waistCm: 72
  })

  assert.equal(reversed.status, 'active', '胸腰差为负：行仍有效（可能只是录反，需现场确认），但无法归并')
  assert.ok(reversed.anomaly.includes('diff_out_of_range'), '胸腰差为负：打 diff_out_of_range 标记')
  assert.equal(reversed.result, null, '胸腰差为负：runMerge 前 result 为空')
  assert.equal(noChest.status, 'invalid', '缺胸围：结构性缺失直接判无效行，不计有效人数')
  assert.match(noChest.statusReason, /胸围/, '缺胸围：无效原因点到胸围，定位到人')

  const pipe = runPipeline(pj, RULE_V1)
  assert.equal(pipe.summary.conserved, false, '异常项目：含未归并行，守恒必须不成立')
  const diff = pipe.summary.unmerged.find((item) => item.name === '胸腰录反')
  assert.ok(diff, '守恒差异清单必须点名「胸腰录反」')
  assert.match(diff!.reason, /胸腰差|型别/, '差异原因可读，定位到哪一步（型别判定）哪个人')
  // 缺胸围是 invalid，不计有效人数，所以不在 unmerged（unmerged 只列有效但没归上的）
  assert.equal(pipe.summary.unmerged.some((item) => item.name === '缺胸围'), false, '缺胸围的人走无效行通道，不进未归并清单')
  assert.equal(pipe.summary.totals.invalidRows, 1, '异常项目：无效行=1')
})

test('判定-4 buildSizeCode 对浮点输入仍由整数运算给号型', () => {
  // 身高 167.50000000000003（167.5 的浮点噪声）+ 胸围 88.0 + 腰围 72 → round_up → 170/88A
  const built = buildSizeCode(RULE_V1, 'male', 167.50000000000003, 88, 72)
  assert.ok(built, '号型构建：浮点噪声输入仍能判定')
  assert.equal(built!.sizeCode, '170/88A', '号型构建：167.5(噪声) round_up→170/88A')
  assert.equal(built!.diffCm, 16, '号型构建：胸腰差 16（整数运算）')
})

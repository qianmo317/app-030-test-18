/**
 * 用例组 6：旧存档（IndexedDB 早期版本落库的 JSON）缺字段时的兼容策略。
 *
 * 策略（src/logic/migrate.ts）：
 *  - 结构性字段缺失：补默认值兼容，项目照常打开（status/anomaly/batch/来源/imports…）
 *  - 量体数值缺失：不伪造 0 以外的数；保持 0，经分析/归并后落到「未归并」或「无效」，
 *    守恒失败 → 导出被拦住，迫使人复核（而不是静默算出个号型）
 *  - 损坏的覆写留痕：剥离 manualOverride，重算后回落规则
 *  - 未知规则版本：按 ruleByVersion 既定行为回落首个内置版本，不崩、不丢数据
 */
import { normalizePerson, normalizeProject } from '../src/logic/migrate'
import {
  RULE_V1,
  RULE_V1_1,
  assert,
  canExportOrderSheet,
  enterManually,
  makeProject,
  runPipeline,
  test
} from './helpers'

test('旧档-1 早期 Person（无 status/anomaly/batch/source 等字段）补默认值后可跑完整链', () => {
  // 模拟最初版本只有：id/name/gender/orgUnit/height/chest/waist
  const legacy = {
    id: 'old-1',
    name: '老学生',
    gender: 'male',
    orgUnit: '2022级1班',
    heightCm: 170,
    chestCm: 88,
    waistCm: 72
  }
  const person = normalizePerson(legacy, 0)
  assert.equal(person.status, 'active', '补默认：缺 status → active')
  assert.deepEqual(person.anomaly, [], '补默认：缺 anomaly → []')
  assert.equal(person.batch, '未分批', '补默认：缺 batch → 未分批')
  assert.equal(person.source, 'manual', '补默认：缺 source → manual')
  assert.equal(person.sourceRow, null, '补默认：缺 sourceRow → null')
  assert.equal(person.specialFlag, null, '补默认：缺 specialFlag → null')
  assert.equal(person.weightKg, null, '补默认：缺体重 → null（不是 0）')
  assert.equal(person.result, null, '补默认：缺 result → null（等待归并）')

  const pj = normalizeProject({ id: 'old-prj', name: '2022 春装', ruleVersion: 'v1.0.0', persons: [legacy] }, [RULE_V1, RULE_V1_1])
  const pipe = runPipeline(pj, RULE_V1)
  assert.equal(pipe.summary.conserved, true, '旧档：补齐默认值的正常人守恒成立')
  assert.equal(pj.persons[0].result?.sizeCode, '170/88A', '旧档：老学生正常归出 170/88A')
  assert.equal(canExportOrderSheet(pipe.summary), true, '旧档：兼容后允许导出')
})

test('旧档-2 缺量体数值的旧记录不伪造：归不进桶、守恒失败、导出门禁拦住并点名', () => {
  const good = normalizePerson(
    { id: 'ok', name: '有数据', gender: 'female', orgUnit: '一班', heightCm: 160, chestCm: 84, waistCm: 68 },
    0
  )
  const noMeasure = normalizePerson(
    { id: 'broken', name: '档案残缺', gender: 'male', orgUnit: '一班' /* 无任何尺寸 */ },
    1
  )
  assert.equal(noMeasure.heightCm, 0, '缺身高：补 0（不伪造身高）')
  assert.equal(noMeasure.chestCm, 0, '缺胸围：补 0')
  assert.equal(noMeasure.waistCm, 0, '缺腰围：补 0')

  const pj = normalizeProject(
    { id: 'prj', name: '残缺项目', ruleVersion: 'v1.0.0', persons: [good, noMeasure] },
    [RULE_V1]
  )
  // 归并对 active 但数值为 0 的人：computeRuleSize 因 !heightCm 返回 null → 未归并
  const pipe = runPipeline(pj, RULE_V1)
  assert.equal(pipe.summary.totals.validRows, 2, '残缺记录：旧行默认 active，计入有效人数 2')
  assert.equal(pipe.summary.totals.accountedQty, 1, '残缺记录：只有 1 人归进桶（有数据的女生）')
  assert.equal(pipe.summary.conserved, false, '残缺记录：守恒必须失败（1≠2）')
  const named = pipe.summary.unmerged.find((item) => item.name === '档案残缺')
  assert.ok(named, '残缺记录：差异清单点名「档案残缺」')
  assert.equal(canExportOrderSheet(pipe.summary), false, '残缺记录：导出门禁拦住，逼现场复核而不是静默下单')
})

test('旧档-3 项目级缺字段（ruleVersion/batches/imports/id）与损坏覆写的兼容', () => {
  const withBadOverride = normalizePerson(
    {
      id: 'p2', name: '带坏覆写', gender: 'male', orgUnit: '一班',
      heightCm: 170, chestCm: 88, waistCm: 72,
      result: { sizeCode: '190/112C', ruleSizeCode: '170/88A', fit: 'A', manualOverride: { sizeCode: '190/112C' } /* 缺 by/reason/at */ }
    },
    1
  )
  assert.equal(withBadOverride.result?.manualOverride, undefined, '坏覆写：缺操作人/原因时覆写留痕被剥离')
  assert.equal(withBadOverride.result?.sizeCode, '190/112C', '坏覆写：存档生效号型保留（不丢数据，等重算）')

  const legacyProject = {
    name: '什么字段都缺',
    persons: [
      { name: '无名氏甲', gender: 'female', heightCm: 160, chestCm: 84, waistCm: 70 },
      withBadOverride
    ]
    // 无 id / ruleVersion / batches / imports / createdAt
  }
  const pj = normalizeProject(legacyProject, [RULE_V1, RULE_V1_1])
  assert.ok(pj.id.startsWith('legacy_project_'), '项目缺 id：生成兜底 id')
  assert.equal(pj.ruleVersion, 'v1.0.0', '项目缺规则版本：回落首个内置版本（与运行时 ruleByVersion 一致）')
  assert.deepEqual(pj.batches, [], '项目缺批次：空数组')
  assert.deepEqual(pj.imports, [], '项目缺导入记录：空数组')
  assert.equal(pj.persons[0].name, '无名氏甲', '人员顺序保留')
  assert.ok(pj.persons[0].id.startsWith('legacy_person_'), '人员缺 id：兜底 id')
  assert.equal(pj.persons[0].orgUnit, '', '人员缺班级：空串（页面显示未填，而不是崩）')

  const pipe = runPipeline(pj, RULE_V1)
  assert.equal(pipe.summary.conserved, true, '缺字段项目：重算后两人都能归并，守恒成立')
  assert.equal(pj.persons[1].result?.sizeCode, '170/88A', '坏覆写：重算后生效号型回落规则，不由坏留痕决定')
  assert.equal(pipe.summary.totals.overrideCount, 0, '坏覆写：不计入覆写条数')
})

test('旧档-4 未知规则版本不崩：回落内置版本并在汇总标注实际所用版本', () => {
  const pj = makeProject('未来版本项目', RULE_V1)
  enterManually(pj, RULE_V1, { name: '未来人', gender: 'male', orgUnit: '一班', heightCm: 170, chestCm: 88, waistCm: 72 })
  pj.ruleVersion = 'v9.9.9-not-installed'

  // 不传 v9.9.9 的规则，归一化按 ruleByVersion 的行为回落（normalize 时回落到首个版本）
  const migrated = normalizeProject(JSON.parse(JSON.stringify(pj)), [RULE_V1, RULE_V1_1])
  assert.equal(migrated.ruleVersion, 'v1.0.0', '未知版本：normalizeProject 回落到 v1.0.0（避免页面/测试两套回落逻辑）')
  const pipe = runPipeline(migrated, RULE_V1)
  assert.equal(pipe.summary.ruleVersion, 'v1.0.0', '未知版本：汇总按 v1.0.0 解释并标注')
  assert.equal(migrated.persons[0].result?.sizeCode, '170/88A', '未知版本：人员正常归并')
})

test('旧档-5 状态字符串非法 / 异常码非法 / 数值是字符串数字时的容错', () => {
  const person = normalizePerson(
    {
      id: 'weird', name: '怪咖', gender: 'unknown-gender-value', orgUnit: '一班',
      heightCm: '167.5', chestCm: '88', waistCm: '72',
      status: 'wait-what', anomaly: ['diff_out_of_range', 'not_a_real_code'],
      result: 'not-an-object'
    },
    0
  )
  assert.equal(person.gender, 'male', '容错：性别只认 female，其余回落 male（与录入默认一致）')
  assert.equal(person.heightCm, 167.5, '容错：字符串数字身高转 number=167.5')
  assert.equal(person.status, 'active', '容错：未知状态回落 active')
  assert.deepEqual(person.anomaly, ['diff_out_of_range'], '容错：非法异常码被过滤，合法码保留')
  assert.equal(person.result, null, '容错：result 不是对象时置 null')

  const pj = normalizeProject({ id: 'p', name: '容错', ruleVersion: 'v1.0.0', persons: [person] }, [RULE_V1])
  const pipe = runPipeline(pj, RULE_V1)
  // 167.5 round_up →170，88/72 diff16 → 170/88A；旧档残留 diff 异常码不影响本次重算
  assert.equal(pj.persons[0].result?.sizeCode, '170/88A', '容错：重算后正常归并 170/88A')
  assert.equal(pipe.summary.conserved, true, '容错：守恒成立')
})

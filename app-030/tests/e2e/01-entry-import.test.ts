/**
 * 链路第 1 步：手工录入 与 表格导入。
 * - 录入：analyzeDraft 的拦截 / 待确认语义；重复行只提示不删除（规格书 §8）。
 * - 导入：100 行含 5 条错误，dry_run 精确定位到行号与原因（规格书 §10）；
 *   正式导入落地后接整链（归并 → 守恒）；同一文件指纹幂等，重传不重复写入。
 */
import { test } from 'node:test'
import { makeCheck, who } from './helpers/check'
import { addPerson, makeDraft, makeProject } from './helpers/factory'
import { runChain } from './helpers/chain'
import { BUILTIN_RULES } from '../../src/logic/sizeRules'
import { analyzeDraft, findDuplicateIds } from '../../src/logic/analyze'
import {
  IMPORT_TEMPLATE_HEADER,
  applyImport,
  buildDryRun,
  createPersonFromDraft,
  detectHeaderRow,
  guessMapping,
  mappedCount,
  type DryRun
} from '../../src/logic/importPlan'
import { fnv1a, parseDelimitedText } from '../../src/logic/csv'
import type { Project } from '../../src/logic/types'

const rule = BUILTIN_RULES.find((item) => item.version === 'v1.0.0')!

test('录入：数值异常拦截与待确认分级（无效行不计入有效人数）', () => {
  const check = makeCheck('录入与导入')
  const project = makeProject({ ruleVersion: rule.version })

  const ok = addPerson(project, rule, { name: '正常生', heightCm: 170, chestCm: 88, waistCm: 72, sourceRow: 1 })
  check.eq(ok.status, 'active', '数据完整的人应为有效行', who(ok))

  const short = addPerson(project, rule, { name: '张太矮', heightCm: 80, chestCm: 60, waistCm: 50, sourceRow: 2 })
  check.eq(short.status, 'invalid', '身高 80cm 应被拦截为无效行', who(short))
  check.ok(short.anomaly.includes('height_out_of_range'), '应标记身高超范围', who(short))

  const noChest = addPerson(project, rule, { name: '张缺胸', heightCm: 170, chestCm: null, waistCm: 70, sourceRow: 3 })
  check.eq(noChest.status, 'invalid', '缺胸围应拦截为无效行', who(noChest))
  check.ok(noChest.anomaly.includes('missing_chest'), '应标记缺少胸围', who(noChest))

  const noGender = analyzeDraft(
    { ...makeDraft({ name: '无性别', heightCm: 170, chestCm: 88, waistCm: 72 }), gender: null },
    rule
  )
  check.eq(noGender.status, 'invalid', '性别无法识别应拦截')

  const skinny = addPerson(project, rule, { name: '张可疑', heightCm: 180, chestCm: 86, waistCm: 72, sourceRow: 4 })
  check.eq(skinny.status, 'active', '胸围小于身高一半：可疑但仍计入有效人数', who(skinny))
  check.ok(skinny.anomaly.includes('chest_out_of_range'), '应标记胸围异常待确认', who(skinny))
  check.eq(skinny.needsConfirm, true, '应要求人工复核', who(skinny))

  const reversed = addPerson(project, rule, { name: '张录反', heightCm: 170, chestCm: 70, waistCm: 88, sourceRow: 5 })
  check.eq(reversed.status, 'active', '胸腰差为负：可疑但仍计入有效人数', who(reversed))
  check.ok(reversed.anomaly.includes('diff_out_of_range'), '应标记胸腰差异常', who(reversed))

  const chain = runChain(project, rule)
  check.eq(chain.summary.totals.invalidRows, 2, '无效行数（张太矮、张缺胸）')
  check.eq(chain.summary.totals.validRows, 3, '有效人数（正常生、张可疑、张录反）')
})

test('录入：重复行只提示不自动删除', () => {
  const check = makeCheck('录入与导入')
  const project = makeProject({ ruleVersion: rule.version })
  const first = addPerson(project, rule, {
    name: '李重复',
    orgUnit: '高一(2)班',
    heightCm: 160,
    weightKg: 50,
    chestCm: 84,
    waistCm: 68,
    sourceRow: 1
  })

  // 录入页的判重路径：同名 + 同班级 + 同身高体重
  const draft = makeDraft({ name: '李重复', orgUnit: '高一(2)班', heightCm: 160, weightKg: 50, chestCm: 84, waistCm: 68 })
  const duplicated = findDuplicateIds(project.persons, draft)
  check.deepEq(duplicated, [first.id], '应提示与既有行重复')
  const second = createPersonFromDraft(draft, rule, `既有行「${duplicated[0]}」`)
  project.persons.push(second)
  check.eq(second.needsConfirm, true, '重复行应要求人工确认', who(second))
  check.eq(second.status, 'active', '重复行仍是有效行，不自动删除', who(second))

  const chain = runChain(project, rule)
  check.eq(chain.summary.totals.validRows, 2, '两条重复记录都计入有效人数（不自动删除）')
  check.eq(chain.summary.totals.duplicateRows, 0, '未经人工确认前不计入「重复行（已排除）」')
})

/** 100 行导入夹具：1 行说明 + 1 行表头 + 100 行数据（5 错误 / 2 无效 / 1 更新 / 2 重复 / 90 新增含 2 特殊） */
function buildImportFixture(): { project: Project; csvText: string; fileName: string; fingerprint: string; dryRun: DryRun } {
  const project = makeProject({ ruleVersion: rule.version, batches: ['春装'] })
  addPerson(project, rule, { name: '王更新', orgUnit: '高一(1)班', heightCm: 170, chestCm: 88, waistCm: 72, sourceRow: 1 })
  addPerson(project, rule, { name: '李正常', orgUnit: '高一(2)班', gender: 'female', heightCm: 160, chestCm: 84, waistCm: 68, sourceRow: 2 })
  addPerson(project, rule, { name: '赵太矮', orgUnit: '高一(3)班', heightCm: 80, chestCm: 60, waistCm: 50, sourceRow: 3 })

  const lines: string[] = ['某某中学 2026 春装量体表（导出勿改）', IMPORT_TEMPLATE_HEADER.join(',')]
  const push = (cells: (string | number)[]) => lines.push(cells.join(','))

  for (let i = 1; i <= 88; i += 1) {
    const male = i % 2 === 1
    const height = male ? 165 + (i % 6) * 2.5 : 155 + (i % 6) * 2.5
    const chest = Math.round((height * 0.52) / 2) * 2
    const diff = male ? 12 + (i % 4) : 14 + (i % 4)
    push([`学生${String(i).padStart(3, '0')}`, male ? '男' : '女', `高一(${(i % 3) + 1})班`, '春装', height, 50 + (i % 30), chest, chest - diff, '', ''])
  }
  push(['特殊甲', '男', '高一(1)班', '春装', 170, 70, 96, 82, 'PLUS', ''])
  push(['特殊乙', '男', '高一(1)班', '春装', 195, 90, 100, 84, 'TALL', ''])
  push(['王更新', '男', '高一(1)班', '春装', 177.5, 66, 92, 78, '', ''])
  push(['', '男', '高一(1)班', '春装', 170, 60, 88, 72, '', ''])
  push(['张性别', '未知', '高一(1)班', '春装', 170, 60, 88, 72, '', ''])
  push(['张身高', '男', '高一(1)班', '春装', 'abc', 60, 88, 72, '', ''])
  push(['张胸围', '男', '高一(1)班', '春装', 170, 60, 'N/A', 72, '', ''])
  push(['张腰围', '男', '高一(1)班', '春装', 170, 60, 88, '七二', '', ''])
  push(['张太矮', '男', '高一(2)班', '春装', 80, 40, 60, 50, '', ''])
  push(['张缺胸', '女', '高一(2)班', '春装', 160, 50, '', 66, '', ''])
  for (let i = 0; i < 2; i += 1) push(['张重复', '女', '高一(2)班', '春装', 160, 55, 84, 70, '', ''])

  const csvText = `${lines.join('\r\n')}\r\n`
  const fileName = '量体100行.csv'
  const fingerprint = `${fileName}|${csvText.length}|${fnv1a(csvText)}`

  const rows = parseDelimitedText(csvText)
  const headerIndex = detectHeaderRow(rows)
  const mapping = guessMapping(rows[headerIndex])
  const dataRows = rows
    .slice(headerIndex + 1)
    .map((cells, index) => ({ cells, lineNo: headerIndex + index + 2 }))
    .filter((row) => row.cells.some((cell) => cell !== ''))
  const dryRun = buildDryRun(dataRows, mapping, project, rule, fileName, fingerprint)
  return { project, csvText, fileName, fingerprint, dryRun }
}

test('导入：100 行含 5 条错误，dry_run 精确定位到行号与原因', () => {
  const check = makeCheck('录入与导入')
  const { dryRun } = buildImportFixture()

  check.deepEq(
    dryRun.counts,
    { new: 92, update: 1, invalid: 2, error: 5, duplicate: 1, total: 100 },
    'dry_run 分类计数（92 新增 / 1 更新 / 2 无效 / 5 错误 / 1 条文件内重复提示）'
  )

  const errors = dryRun.rows.filter((row) => row.kind === 'error')
  check.deepEq(errors.map((row) => row.lineNo), [94, 95, 96, 97, 98], '错误行行号（含说明行与表头的偏移）')
  check.match(errors[0].reason, /缺少姓名/, '第 94 行原因')
  check.match(errors[1].reason, /性别「未知」无法识别/, '第 95 行原因')
  check.match(errors[2].reason, /身高「abc」不是有效数字/, '第 96 行原因')
  check.match(errors[3].reason, /胸围「N\/A」不是有效数字/, '第 97 行原因')
  check.match(errors[4].reason, /腰围「七二」不是有效数字/, '第 98 行原因')

  const invalids = dryRun.rows.filter((row) => row.kind === 'invalid')
  check.deepEq(invalids.map((row) => row.lineNo), [99, 100], '无效行行号')
  check.match(invalids[0].reason, /身高 80cm 超出/, '第 99 行原因（数值异常拦截）')
  check.match(invalids[1].reason, /缺少胸围/, '第 100 行原因')

  const update = dryRun.rows.find((row) => row.kind === 'update')!
  check.eq(update.lineNo, 93, '王更新按「姓名 + 班级」匹配到既有记录，应判为更新')

  const duplicates = dryRun.rows.filter((row) => row.duplicateOf !== null)
  check.deepEq(duplicates.map((row) => row.lineNo), [102], '文件内重复只提示（第 102 行重复第 101 行）')
  check.eq(duplicates[0].duplicateOf, '本文件第 101 行', '重复提示应指向文件内行号')
  check.eq(duplicates[0].kind, 'new', '重复行不自动删除，仍按新增处理')
})

test('导入：正式导入落地 → 整链守恒；同一文件指纹幂等', () => {
  const check = makeCheck('录入与导入')
  const { project, fingerprint, dryRun } = buildImportFixture()

  const applied = applyImport(project, dryRun, rule)
  check.deepEq(applied, { added: 92, updated: 1, invalid: 2, skipped: 5 }, '正式导入结果计数')
  check.eq(project.persons.length, 97, '3 条手工 + 92 新增 + 2 无效 = 97 行（更新不增行、错误行跳过）')

  const updated = project.persons.find((person) => person.name === '王更新')!
  check.eq(updated.heightCm, 177.5, '更新行应写入新量体数据', who(updated))
  check.eq(updated.sourceRow, 93, '更新后来源行号指向导入行', who(updated))

  const chain = runChain(project, rule)
  check.eq(chain.summary.totals.totalRows, 97, '总录入行数')
  check.eq(chain.summary.totals.invalidRows, 3, '无效行（手工 1 + 导入 2）')
  check.eq(chain.summary.totals.validRows, 94, '有效人数')
  check.eq(chain.summary.totals.regularQty, 92, '常规档套数')
  check.eq(chain.summary.totals.specialQty, 2, '特殊单列套数（PLUS / TALL）')
  check.eq(chain.summary.conserved, true, '常规 + 特殊 = 有效人数，守恒成立')
  check.eq(chain.conservation, '常规 92 + 特殊 2 = 有效 94 / 总录入 97', '守恒等式文本（页面与导出共用）')

  // 幂等：与 ImportView 相同的指纹守卫——重传同一文件在落地前被阻止
  const alreadyImported = project.imports.some((record) => record.fingerprint === fingerprint)
  check.eq(alreadyImported, true, '同一文件指纹已登记，重传应被阻止')
  const before = project.persons.length
  if (!alreadyImported) applyImport(project, dryRun, rule)
  check.eq(project.persons.length, before, '被阻止后人数不变（幂等）')
})

test('导入：表头识别与列映射（说明行在前也能定位表头）', () => {
  const check = makeCheck('录入与导入')
  const { csvText } = buildImportFixture()
  const rows = parseDelimitedText(csvText)
  const headerIndex = detectHeaderRow(rows)
  check.eq(headerIndex, 1, '表头在第 2 行（第 1 行是说明文字）')
  const mapping = guessMapping(rows[headerIndex])
  check.eq(mappedCount(mapping), 10, '模板的 10 个列应全部映射')
})

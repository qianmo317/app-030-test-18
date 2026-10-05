/**
 * 旧存档兼容：早期版本写出的 IndexedDB 记录缺字段时的行为契约（migrate.ts）。
 * - 兼容：缺可选字段 → 补默认值，照常进入整条链（归并 / 守恒 / 导出）；
 * - 旧存档里的人工覆写必须保留（留痕不能丢）；
 * - 拦住（行级）：缺性别 → 保留但标无效；记录损坏 → 占位无效行；缺测量值 →
 *   走「未归并 → 守恒不通过 → 禁止导出」链路；
 * - 拦住（整条）：记录不是对象 / 无 id / persons 非数组 → 拒绝该条，不拖垮其它项目；
 * - 规范化幂等：normalize(normalize(x)) === normalize(x)。
 */
import { test } from 'node:test'
import { makeCheck, who } from './helpers/check'
import { addPerson, makeProject } from './helpers/factory'
import { runChain } from './helpers/chain'
import { BUILTIN_RULES } from '../../src/logic/sizeRules'
import { normalizeProject } from '../../src/logic/migrate'
import type { Project } from '../../src/logic/types'

const rule = BUILTIN_RULES.find((item) => item.version === 'v1.0.0')!

/** 构造一份「旧存档」：正常项目 → JSON 往返（模拟落盘）→ 删掉后期才加的字段 */
function buildLegacyArchive(): Record<string, unknown> {
  const project = makeProject({ ruleVersion: rule.version })
  for (let i = 0; i < 10; i += 1) {
    const gender = i % 2 === 0 ? 'male' : 'female'
    const height = 160 + i * 2.5
    const chest = Math.round((height * 0.52) / 2) * 2
    const diff = gender === 'male' ? 14 : 16
    addPerson(project, rule, {
      name: `旧生${i}`,
      gender,
      heightCm: height,
      chestCm: chest,
      waistCm: chest - diff,
      specialFlag: i === 4 ? 'PLUS' : null,
      sourceRow: i + 1
    })
  }
  const stored = JSON.parse(JSON.stringify(project)) as Record<string, unknown>
  delete stored.kind
  delete stored.batches
  delete stored.imports
  delete stored.perf
  delete stored.createdAt
  delete stored.updatedAt
  for (const person of stored.persons as Record<string, unknown>[]) {
    delete person.batch
    delete person.note
    delete person.anomaly
    delete person.needsConfirm
    delete person.possibleDuplicateOf
    delete person.sourceRow
    delete person.source
    delete person.createdAt
    delete person.statusReason
    delete person.result
  }
  // 旧生0：旧版结果对象（只有 sizeCode，没有 ruleSizeCode / fit / ruleVersion）
  ;(stored.persons as Record<string, unknown>[])[0].result = { sizeCode: '170/88A' }
  // 旧生1：旧版结果里带人工覆写（缺 at 时间戳）——留痕必须保留
  ;(stored.persons as Record<string, unknown>[])[1].result = {
    sizeCode: '175/92B',
    manualOverride: { sizeCode: '175/92B', by: '旧操作员', reason: '历史覆写' }
  }
  return stored
}

test('旧存档：缺可选字段 → 补默认值兼容，整条链照常跑通', () => {
  const check = makeCheck('旧存档兼容')
  const normalized = normalizeProject(buildLegacyArchive())
  check.ok(normalized !== null, '缺可选字段的存档应被兼容加载')
  const project = normalized as Project

  check.deepEq(project.batches, [], '缺 batches → 默认空数组')
  check.deepEq(project.imports, [], '缺 imports → 默认空数组')
  check.eq(project.kind, 'other', '缺 kind → 默认 other')
  check.eq(project.persons[0].sourceRow, null, '缺 sourceRow → null')
  check.eq(project.persons[0].source, 'import', '缺 source → 默认 import（旧存档多为批量导入）')
  check.deepEq(project.persons[0].anomaly, [], '缺 anomaly → 默认空数组')

  const chain = runChain(project, rule)
  check.eq(chain.summary.totals.validRows, 10, '有效人数（10 人全部进入链路）')
  check.eq(chain.summary.totals.specialQty, 1, '特殊单列 1 套（旧生4 PLUS）')
  check.eq(chain.summary.totals.regularQty, 9, '常规档 9 套')
  check.eq(chain.summary.conserved, true, '守恒成立，允许导出下单表')

  const overridden = project.persons[1]
  check.eq(overridden.result?.sizeCode, '175/92B', '旧存档的人工覆写保留为生效号型', who(overridden))
  check.eq(overridden.result?.manualOverride?.by, '旧操作员', '覆写留痕（操作人）不丢', who(overridden))
  check.eq(overridden.result?.manualOverride?.reason, '历史覆写', '覆写留痕（原因）不丢', who(overridden))
  check.eq(overridden.result?.manualOverride?.at, 0, '缺时间戳 → 0（不伪造时间）', who(overridden))
  check.eq(chain.summary.totals.overrideCount, 1, '覆写计数进入汇总')

  const recomputed = project.persons[0]
  check.notEq(recomputed.result?.ruleSizeCode ?? '', '', '旧版结果对象在重跑归并后被重算补全', who(recomputed))
})

test('旧存档：规范化幂等', () => {
  const check = makeCheck('旧存档兼容')
  const once = normalizeProject(buildLegacyArchive())
  const twice = normalizeProject(JSON.parse(JSON.stringify(once)))
  check.deepEq(twice, once, 'normalize(normalize(x)) 必须等于 normalize(x)')
})

test('旧存档：缺性别 → 行级拦住（无效行）；记录损坏 → 占位无效行；缺测量值 → 守恒拦住导出', () => {
  const check = makeCheck('旧存档兼容')
  const archive = {
    id: 'legacy_b',
    name: '缺字段存档',
    ruleVersion: rule.version,
    persons: [
      { id: 'b1', name: '齐全', gender: 'male', heightCm: 170, chestCm: 88, waistCm: 72 },
      { id: 'b2', name: '缺性别', heightCm: 170, chestCm: 88, waistCm: 72 },
      null,
      { id: 'b4', name: '缺测量', gender: 'female' }
    ]
  }
  const project = normalizeProject(archive) as Project
  check.ok(project !== null, '项目整体可加载')

  const [ok, noGender, broken, noMeasure] = project.persons
  check.eq(ok.status, 'active', '齐全行为有效行', who(ok))
  check.eq(noGender.status, 'invalid', '缺性别 → 无效行（行级拦住）', who(noGender))
  check.match(noGender.statusReason, /旧存档缺字段：性别缺失或无法识别/, '拦住原因留痕', who(noGender))
  check.eq(broken.status, 'invalid', '损坏记录 → 占位无效行', who(broken))
  check.match(broken.name, /旧存档损坏行 #3/, '占位行标明原行位', who(broken))
  check.eq(noMeasure.status, 'active', '缺测量值的行保持有效（由守恒链路拦）', who(noMeasure))

  const chain = runChain(project, rule)
  check.eq(chain.summary.totals.totalRows, 4, '总录入行数不变（损坏行也保留行位）')
  check.eq(chain.summary.totals.invalidRows, 2, '无效行：缺性别 + 损坏占位')
  check.eq(chain.summary.totals.validRows, 2, '有效人数：齐全 + 缺测量')
  check.eq(chain.summary.conserved, false, '缺测量值 → 未归并 → 守恒不通过')
  check.eq(chain.summary.unmerged.length, 1, '未归并清单定位到缺测量的人')
  check.eq(chain.summary.unmerged[0].name, '缺测量', '未归并清单给出姓名')
  const exportBlocked = !chain.summary.conserved
  check.eq(exportBlocked, true, '下单表导出被阻止')

  // 人工复核后补录测量值 → 守恒恢复
  noMeasure.heightCm = 160
  noMeasure.chestCm = 84
  noMeasure.waistCm = 68
  const healed = runChain(project, rule)
  check.eq(healed.summary.conserved, true, '补录后守恒恢复，允许导出')
  check.eq(healed.summary.totals.accountedQty, 2, '补录后全部归账')
})

test('旧存档：整条不兼容 → 拦住且不影响其它项目', () => {
  const check = makeCheck('旧存档兼容')
  check.eq(normalizeProject(null), null, 'null 记录整条拒绝')
  check.eq(normalizeProject('junk'), null, '非对象记录整条拒绝')
  check.eq(normalizeProject({}), null, '缺 id 整条拒绝')
  check.eq(normalizeProject({ id: 'x' }), null, '缺 persons 整条拒绝')
  check.eq(normalizeProject({ id: 'x', persons: 'not-array' }), null, 'persons 非数组整条拒绝')

  const mixed: unknown[] = [buildLegacyArchive(), null, { id: 'broken' }, 'junk']
  const loaded = mixed.map(normalizeProject).filter((item): item is Project => item !== null)
  check.eq(loaded.length, 1, '坏存档被跳过，好存档照常加载')
  check.eq(loaded[0].persons.length, 10, '好存档数据完整')
})

test('旧存档：缺 ruleVersion → 落到默认规则版本并在汇总中标注', () => {
  const check = makeCheck('旧存档兼容')
  const archive = buildLegacyArchive()
  delete archive.ruleVersion
  const project = normalizeProject(archive) as Project
  check.eq(project.ruleVersion, 'v1.0.0', '缺 ruleVersion → 默认内置首版规则')
  const chain = runChain(project, rule)
  check.eq(chain.summary.ruleVersion, 'v1.0.0', '汇总标注实际使用的规则版本')
})

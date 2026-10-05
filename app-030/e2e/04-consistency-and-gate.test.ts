/**
 * 用例组 4：守恒门禁与三处呈现的对账基准。
 *
 * 基准选择（详见 TESTING.md）：以页面汇总模型（buildSummary 的 Summary）为基准，
 * 导出表 / 打印稿 / 明细都是它的下游投影——理由是下单表是发给厂方的外部单据，
 * 一旦页面与导出不一致，必须改代码而不是改数据。因此导出是被测对象。
 * 本组把「页面有的每一档、每一小计、合计、守恒等式」逐一到导出里找回相等值，
 * 反向也要求导出不出现页面没有的档（防止导出层私造桶）。
 */
import { canExportOrderSheet, exportBlockReason } from '../src/logic/exporter'
import { conservationText } from '../src/logic/merge'
import {
  RULE_V1,
  assert,
  buildXlsxBytes,
  csvRows,
  detailRowByName,
  enterManually,
  makeProject,
  orderDataRows,
  pageOrderView,
  printOrderView,
  readOurXlsx,
  runPipeline,
  test
} from './helpers'

test('门禁-1 存在未归并的有效人时：守恒失败、下单导出被唯一门禁拦住并点名', () => {
  const pj = makeProject('不守恒项目', RULE_V1)
  enterManually(pj, RULE_V1, { name: '正常人', gender: 'male', orgUnit: '一班', heightCm: 170, chestCm: 88, waistCm: 72 })
  // 男 diff=16.5 不在任何型别区间 → 有效但无法归并
  const stuck = enterManually(pj, RULE_V1, { name: '归不上', gender: 'male', orgUnit: '一班', heightCm: 172, chestCm: 90, waistCm: 73.5 })

  const pipe = runPipeline(pj, RULE_V1)
  assert.equal(stuck.result, null, '前置：归不上 没有规则结果')
  assert.equal(pipe.summary.conserved, false, '守恒：2 个有效人只归上 1 套，必须失败')
  assert.equal(canExportOrderSheet(pipe.summary), false, '门禁：canExportOrderSheet 必须返回 false（页面按钮禁用与测试用同一判准）')
  assert.match(exportBlockReason(pipe.summary), /未归并/, '门禁：阻止原因可读')

  const named = pipe.summary.unmerged.find((item) => item.name === '归不上')
  assert.ok(named, '差异明细：必须点名「归不上」')
  assert.equal(typeof named!.sourceRow, 'number', '差异明细：带来源行号，能回到导入/录入那一步定位')
  assert.match(named!.reason, /胸腰差|型别/, '差异明细：原因指向型别判定步骤')

  // 页面上的等式文本本身也要钉住（SummaryView / ExportView 渲染它）
  assert.match(conservationText(pipe.summary), /^常规 1 \+ 特殊 0 = 有效 2 \/ 总录入 2$/, '等式文本：常规1+特殊0≠有效2 的原样输出')

  // 处理掉（人工覆写）之后门禁打开：走真实覆写路径
  stuck.result = {
    sizeCode: '170/88B', ruleSizeCode: '', fit: null, ruleVersion: 'v1.0.0',
    manualOverride: { sizeCode: '170/88B', by: '业务员', reason: '现场确认按 B 型定制', at: 1 }
  }
  const fixed = runPipeline(pj, RULE_V1)
  assert.equal(fixed.summary.conserved, true, '覆写兜底：归不上的人被人工落桶后守恒成立')
  assert.equal(canExportOrderSheet(fixed.summary), true, '门禁：处理完差异后放行下单导出')
  assert.equal(fixed.summary.totals.overrideCount, 1, '覆写兜底：报告 1 条覆写')
})

test('对账-1 页面为基准：下单表/打印稿的档、数量、合计、单位小计与页面双向一致', () => {
  const pj = makeProject('对账项目', RULE_V1, ['春装'])
  enterManually(pj, RULE_V1, { name: '赵一', gender: 'male', orgUnit: '车间甲', heightCm: 170, chestCm: 88, waistCm: 72 })
  enterManually(pj, RULE_V1, { name: '赵二', gender: 'male', orgUnit: '车间甲', heightCm: 175, chestCm: 96, waistCm: 80 })
  enterManually(pj, RULE_V1, { name: '钱三', gender: 'female', orgUnit: '车间乙', heightCm: 160, chestCm: 84, waistCm: 66 })
  enterManually(pj, RULE_V1, { name: '李四', gender: 'male', orgUnit: '车间乙', heightCm: 180, weightKg: 90, chestCm: 110, waistCm: 104, specialFlag: 'PLUS' })

  const pipe = runPipeline(pj, RULE_V1)
  const { summary } = pipe
  assert.equal(summary.conserved, true, '前置：守恒')

  const page = pageOrderView(summary)
  const printed = printOrderView(pipe.ctx)
  const csv = orderDataRows(csvRows(pipe.orderRows) as (string | number)[][])

  // 双向对账：页面 → 导出
  for (const view of page) {
    const labelOf = (label: string) => (view.isSpecial ? label.includes('加肥加大') : label === view.code)
    const inCsv = csv.find((row) => labelOf(row.label) && row.gender === view.gender)
    assert.ok(inCsv, `页面→导出：页面档 ${view.code}/${view.gender} 在 CSV 下单表缺失`)
    assert.equal(inCsv.qty, view.qty, `页面→导出：${view.code} 数量 ${view.qty}≠${inCsv.qty}`)
    const inPrint = printed.find((row) => labelOf(row.label) && row.gender === view.gender)
    assert.ok(inPrint, `页面→打印：${view.code} 打印稿缺失`)
    assert.equal(inPrint.qty, view.qty, `页面→打印：${view.code} 数量不一致`)
  }
  // 导出 → 页面：导出不得有页面没有的档
  for (const row of csv) {
    const found = page.some((view) => (row.kind === '特殊单列' ? view.isSpecial : !view.isSpecial) && view.gender === row.gender && view.qty === row.qty)
    assert.ok(found, `导出→页面：导出档「${row.label}/${row.gender}×${row.qty}」在页面找不到——导出层私造桶`)
  }

  // 合计与有效人数
  const totalLine = pipe.orderRows.find((row) => row[1] === '合计')!
  const peopleLine = pipe.orderRows.find((row) => row[1] === '有效人数')!
  assert.equal(Number(totalLine[4]), summary.totals.accountedQty, '合计：导出合计套数=页面 accountedQty')
  assert.equal(Number(peopleLine[4]), summary.totals.validRows, '合计：导出有效人数=页面 validRows')

  // 单位小计：导出「按班级车间小计」页签的每个单位合计 = 页面 byOrgUnit
  for (const group of summary.byOrgUnit) {
    const subtotalLine = pipe.orgRows.find((row) => row[0] === `${group.orgUnit} 小计`)
    assert.ok(subtotalLine, `单位小计：${group.orgUnit} 的小计行在导出表缺失`)
    assert.equal(Number(subtotalLine![5]), group.regularQty + group.specialQty, `单位小计：${group.orgUnit} 导出小计≠页面小计`)
    // 单位下每一档也能对回 group.rows
    const unitLines = pipe.orgRows.filter((row) => row[0] === group.orgUnit)
    assert.equal(unitLines.length, group.rows.length, `单位明细：${group.orgUnit} 档位数一致`)
  }
  const subtotalSum = pipe.orgRows
    .filter((row) => String(row[0]).endsWith('小计'))
    .reduce((sum, row) => sum + Number(row[5]), 0)
  assert.equal(subtotalSum, summary.totals.accountedQty, '单位小计之和 = 总套数（分档守恒）')

  // 元信息：规则版本、守恒结论、项目名进单（厂方单据可追溯到规则版本）
  const metaText = pipe.orderRows.slice(0, 6).map((row) => row.join(':')).join('\n')
  assert.match(metaText, /v1\.0\.0/, '单据元信息：带规则版本号')
  assert.match(metaText, /通过/, '单据元信息：守恒结论=通过')
  assert.match(metaText, /对账项目/, '单据元信息：带项目名')
})

test('对账-2 量体明细逐行回贴：每个人的生效号型与页面档位归属一致', () => {
  const pj = makeProject('回贴项目', RULE_V1)
  const persons = [
    enterManually(pj, RULE_V1, { name: '回一', gender: 'male', orgUnit: '一班', heightCm: 170, chestCm: 88, waistCm: 72 }),
    enterManually(pj, RULE_V1, { name: '回二', gender: 'female', orgUnit: '一班', heightCm: 162.5, chestCm: 86, waistCm: 70 })
  ]
  const pipe = runPipeline(pj, RULE_V1)

  for (const person of persons) {
    const line = detailRowByName(pipe.detail, person.name)
    assert.equal(line['生效号型'], person.result!.sizeCode, `明细回贴：${person.name} 生效号型与归并结果一致`)
    assert.equal(line['规则号型'], person.result!.ruleSizeCode, `明细回贴：${person.name} 规则号型一致`)
    assert.equal(line['状态'], '有效', `明细回贴：${person.name} 状态有效`)
    // 页面分档桶里必须真的算着这个人：把所有明细生效号型计数，应与页面 allRows 逐项相等
  }

  // 明细计数 → 页面分档
  const tally = new Map<string, number>()
  for (let i = 1; i < pipe.detail.length; i += 1) {
    const row = pipe.detail[i]
    if (row[16] !== '有效') continue // 状态列
    const code = String(row[11]) // 生效号型
    const gender = row[2] === '男' ? 'male' : 'female'
    if (!code) continue
    tally.set(`${code}|${gender}`, (tally.get(`${code}|${gender}`) ?? 0) + 1)
  }
  for (const row of pipe.summary.allRows) {
    const key = `${row.sizeCode}|${row.gender}`
    assert.equal(tally.get(key), row.qty, `明细→分档：${key} 明细计数 ${tally.get(key) ?? 0} ≠ 页面 ${row.qty}`)
    tally.delete(key)
  }
  assert.equal(tally.size, 0, '明细→分档：明细里不应存在页面没有的生效号型')
})

test('对账-3 XLSX 与 CSV 两种导出彼此逐行一致（格式不同，结论相同）', async () => {
  const pj = makeProject('双格式项目', RULE_V1)
  enterManually(pj, RULE_V1, { name: '格甲', gender: 'male', orgUnit: '一班', heightCm: 170, chestCm: 88, waistCm: 72 })
  enterManually(pj, RULE_V1, { name: '格乙', gender: 'female', orgUnit: '二班', heightCm: 160, chestCm: 84, waistCm: 70 })
  const pipe = runPipeline(pj, RULE_V1)

  const book = readOurXlsx(await buildXlsxBytes(pipe.orderSheets))
  const csv = csvRows(pipe.orderRows)
  const headerAt = book[0].rows.findIndex((row) => row.some((cell) => cell.value === '数量'))

  // XLSX 行数 = CSV 行数（行内逐格对齐，尾部空单元格按写入器约定互相补齐）
  assert.equal(book[0].rows.length, csv.length, 'XLSX/CSV：两个文件物理行数一致')
  for (let i = 0; i < csv.length; i += 1) {
    const width = Math.max(csv[i].length, book[0].rows[i].length)
    const xRow = book[0].rows[i].map((cell) => cell.value)
    for (let j = 0; j < width; j += 1) {
      const xValue = xRow[j] ?? ''
      const cValue = csv[i][j] ?? ''
      assert.equal(xValue, cValue, `XLSX/CSV：第 ${i + 1} 行第 ${j + 1} 列文本不一致`)
    }
  }
  // 数据行数量列在 XLSX 是数值类型（SUM 可用），CSV 回读为数字字符串
  const firstData = book[0].rows[headerAt + 1]
  assert.equal(firstData[4].type, 'n', 'XLSX：数量列数值类型')
  assert.equal(firstData[1].type, 's', 'XLSX：号型列文本类型')
  assert.match(csv[headerAt + 1][4], /^\d+$/, 'CSV：数量单元格为纯数字文本，Excel 打开按数值参与求和')
})

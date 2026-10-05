/**
 * 用例组 1：整条数据流的端到端金标准。
 * 一批人来自两个入口（手工录入 + 表格导入，含错误行 / 无效行 / 疑似重复 / 特殊体型），
 * 经过 半厘米归一 → 档位与型别判定 → 覆写 → 分档小计与守恒 → 页面小计 →
 * 下单汇总表（CSV/XLSX）→ 量体明细（CSV/XLSX）→ 打印稿，
 * 三处呈现（页面 / 导出 / 明细+打印）对同一批人必须给出同一组结论。
 */
import {
  RULE_V1,
  assert,
  csvRows,
  detailRowByName,
  enterManually,
  importTable,
  makeProject,
  orderDataRows,
  pageOrderView,
  printOrderView,
  readOurXlsx,
  buildXlsxBytes,
  runPipeline,
  test
} from './helpers'

test('E2E-1 全链路：手工+导入同一批人，三处呈现结论一致、守恒成立', async () => {
  const project = makeProject('一中高一春装', RULE_V1, ['春装'])

  // —— 入口 A：手工录入 3 人（含 1 个特殊体型）——
  const manA = enterManually(project, RULE_V1, {
    name: '手录甲', gender: 'male', orgUnit: '高一(1)班',
    heightCm: 170, weightKg: 62, chestCm: 88, waistCm: 72, note: '第一排'
  })
  enterManually(project, RULE_V1, {
    name: '手录乙', gender: 'female', orgUnit: '高一(1)班',
    heightCm: 160, weightKg: 50, chestCm: 84, waistCm: 66
  })
  enterManually(project, RULE_V1, {
    name: '手录丙', gender: 'male', orgUnit: '高一(2)班',
    heightCm: 175, weightKg: 95, chestCm: 112, waistCm: 105, specialFlag: 'PLUS'
  })

  // —— 入口 B：表格导入（dry_run 两步式的第二步在 importTable 内一并执行）——
  // 行 1(导入丁) 与手录甲同档（170/88A 男）；行 2(导入戊) 归 160/84B 女；
  // 行 3(导入己) 无效（身高越界）；行 4(导入庚) 错误（性别无法识别）；
  // 行 5 是行 1 的完全重复（同名同班同身高体重，只提示不删除）；行 6(导入辛) 归 170/92B 男
  const csv = [
    '姓名,性别,班级,批次,身高,体重,胸围,腰围,备注',
    '导入丁,男,高一(1)班,春装,169,63,87,75,边界附近',
    '导入戊,女,高一(2)班,春装,158,48,82,70,',
    '导入己,男,高一(1)班,春装,75,20,60,55,身高异常',
    '导入庚,X,高一(1)班,春装,170,60,88,72,性别错误',
    '导入丁,男,高一(1)班,春装,169,63,87,75,重复行',
    '导入辛,男,高一(1)班,春装,172,66,90,79,172/90A 男'
  ].join('\n')

  const { dryRun, applied } = importTable(project, RULE_V1, csv, '春装量体.csv')
  // —— dry_run 计数（钉住导入阶段的判定）——
  assert.equal(dryRun.counts.total, 6, '导入阶段：数据行总数应为 6')
  assert.equal(dryRun.counts.new, 4, '导入阶段：新增应为 4（丁/戊/重复丁/辛；重复行只标记不剔除）')
  assert.equal(dryRun.counts.invalid, 1, '导入阶段：无效行应为 1（身高 75）')
  assert.equal(dryRun.counts.error, 1, '导入阶段：错误行应为 1（性别 X）')
  assert.equal(dryRun.counts.duplicate, 1, '导入阶段：疑似重复应提示 1 行（第 2 个导入丁），但不自动删除')

  const dupRow = dryRun.rows.find((row) => row.lineNo === 6)!
  assert.ok(dupRow.duplicateOf, '导入阶段：第 6 行应带 duplicateOf 定位信息')
  assert.equal(dupRow.kind, 'new', '导入阶段：重复行只提示不删除，仍计入新增')

  const invalidRow = dryRun.rows.find((row) => row.lineNo === 4)!
  assert.equal(invalidRow.kind, 'invalid', '导入阶段：第 4 行（身高 75）必须被判无效')
  assert.match(invalidRow.reason, /身高/, '导入阶段：无效原因要点到身高，失败定位到行号+原因')
  const errorRow = dryRun.rows.find((row) => row.lineNo === 5)!
  assert.equal(errorRow.kind, 'error', '导入阶段：第 5 行（性别 X）必须是错误行')
  assert.match(errorRow.reason, /性别/, '导入阶段：错误原因要点到性别')

  assert.deepEqual(applied, { added: 4, updated: 0, invalid: 1, skipped: 1 }, '正式导入计数：4 新增 / 1 无效 / 1 跳过错误行')

  // —— 同一文件指纹幂等：重传不产生重复 ——
  const second = importTable(project, RULE_V1, csv, '春装量体.csv', csv.length)
  assert.equal(second.alreadyImported, true, '导入阶段：同一文件指纹第二次必须被幂等门禁认出')
  const personsAfterSecond = project.persons.length
  assert.equal(personsAfterSecond, 8, '导入阶段：幂等重传后人数不变（3 手录 + 5 落库：4 有效 + 1 无效；性别错误行已跳过）')

  // —— 归并 / 汇总 / 三处呈现 ——
  const pipe = runPipeline(project, RULE_V1)
  const { summary } = pipe

  assert.equal(summary.totals.totalRows, 8, '分档小计阶段：总录入 8')
  assert.equal(summary.totals.invalidRows, 1, '分档小计阶段：无效 1（身高 75）')
  assert.equal(summary.totals.validRows, 7, '分档小计阶段：有效 7（错误行没落库，无效行落库但不计有效）')

  // 期望套数分布（逐号型钉死，不是只验总数）：
  // 170/88A 男 = 手录甲 + 导入丁×2(重复保留) = 3
  // 170/88B 男 = 导入辛? 172→170, 90→88 就近? chestAnchor84 step4：90→(90-84)/4=1.5→2k=2 →92? 见下断言用实际档；diff=90-79=11→B
  // 160/84A 女 = 手录乙 + 导入戊 = 2
  // 155/84A? 导入戊 158→160(round_up: (158-155)/5=0.6→1)；82→82? (82-84)/4=-0.5 round_up→0k=0→84；diff=12→A
  // 特殊 PLUS 男 = 手录丙 = 1
  // 校验导入丁：169→170，87→88（(87-84)/4=0.75→1→88），diff=87-75=12→A → 170/88A 男
  const rowOf = (code: string, gender: 'male' | 'female') =>
    summary.allRows.find((row) => row.sizeCode === code && row.gender === gender)

  assert.equal(rowOf('170/88A', 'male')?.qty, 3, '分档小计：170/88A 男应=3（手录甲+导入丁×2），若失败说明归并/去重某步对不上')
  // 导入辛：172→170（(172-155)/5=3.4→3→170）；胸围 90→(90-84)/4=1.5 round_up 半档归上 → k=2 → 92；diff 11 → B
  assert.equal(rowOf('170/92B', 'male')?.qty, 1, '分档小计：导入辛应为 170/92B 男')
  // 手录乙：160，84，diff 18→ 女装 v1.0.0 A 区间 14~18 闭区间端点 18 → A
  assert.equal(rowOf('160/84A', 'female')?.qty, 1, '分档小计：160/84A 女=1（手录乙，diff 18 正好压在 A 区间上端点）')
  // 导入戊 diff=82-70=12，女装 v1.0.0 B 9~13 → B；胸围 82→84；158→160 → 160/84B 女
  assert.equal(rowOf('160/84B', 'female')?.qty, 1, '分档小计：导入戊 160/84B 女=1（diff12 在女装 B 档）')
  assert.equal(summary.specialRows.find((row) => row.sizeCode === 'PLUS' && row.gender === 'male')?.qty, 1, '分档小计：PLUS 男=1')

  assert.equal(summary.totals.regularQty, 6, '守恒：常规档 6 套')
  assert.equal(summary.totals.specialQty, 1, '守恒：特殊单列 1 套')
  assert.equal(summary.totals.accountedQty, 7, '守恒：常规 6 + 特殊 1 = 7')
  assert.equal(summary.conserved, true, '守恒：本批必须守恒（未归并=0）')
  assert.equal(summary.unmerged.length, 0, '守恒：未归并清单应为空')

  // —— 页面小计（SummaryView 的 byOrgUnit 口径）——
  const org1 = summary.byOrgUnit.find((group) => group.orgUnit === '高一(1)班')!
  assert.equal(org1.validCount, 5, '页面小计：高一(1)班 有效 5（甲乙 + 丁×2 + 辛；己无效不计）')
  assert.equal(org1.invalidCount, 1, '页面小计：高一(1)班 无效/排除 1（导入己）')
  assert.equal(org1.regularQty + org1.specialQty, 5, '页面小计：高一(1)班 小计 5 套')
  const org2 = summary.byOrgUnit.find((group) => group.orgUnit === '高一(2)班')!
  assert.equal(org2.regularQty + org2.specialQty, 2, '页面小计：高一(2)班 小计 2（戊常规 + 丙特殊；乙在 1 班）')

  // —— 三处呈现同一组结论：页面视图 / 导出下单表 / 打印稿逐项相等 ——
  const page = pageOrderView(summary)
  const printed = printOrderView(pipe.ctx)
  const exported = orderDataRows(pipe.orderRows)

  assert.equal(page.length, printed.length, '三处一致：页面档数 = 打印稿档数')
  assert.equal(page.length, exported.length, '三处一致：页面档数 = 导出表档数')
  assert.equal(
    page.reduce((sum, item) => sum + item.qty, 0),
    7,
    '三处一致：页面合计 7'
  )

  for (const view of page) {
    const matches = (label: string) => (view.isSpecial ? label.includes('加肥加大') : label === view.code)
    const printItem = printed.find((item) => matches(item.label) && item.gender === view.gender)
    assert.ok(printItem, `三处一致：页面档「${view.code}/${view.gender}」在打印稿找不到——打印阶段对不上`)
    assert.equal(printItem.qty, view.qty, `三处一致：${view.code} 页面数量 ${view.qty} ≠ 打印稿数量 ${printItem.qty}`)
    const fileItem = exported.find((item) => matches(item.label) && item.gender === view.gender)
    assert.ok(fileItem, `三处一致：页面档「${view.code}/${view.gender}」在导出表找不到——导出阶段对不上`)
    assert.equal(fileItem.qty, view.qty, `三处一致：${view.code} 页面数量 ${view.qty} ≠ 导出数量 ${fileItem.qty}`)
  }

  // 合计行：下单表「合计」=7，「有效人数」=7
  const totalLine = pipe.orderRows.find((row) => row[1] === '合计')!
  const peopleLine = pipe.orderRows.find((row) => row[1] === '有效人数')!
  assert.equal(Number(totalLine[4]), 7, '导出：下单表合计套数=7')
  assert.equal(Number(peopleLine[4]), 7, '导出：下单表有效人数=7')

  // 按班级/车间小计页签里每个单位小计之和 = 总套数
  const orgSubtotals = pipe.orgRows.filter((row) => String(row[0]).includes('小计'))
  const orgSum = orgSubtotals.reduce((sum, row) => sum + Number(row[5]), 0)
  assert.equal(orgSum, 7, '导出：按班级小计之和=7，与总表守恒')

  // —— 量体明细：逐个人钉到行 ——
  const lineDing = detailRowByName(pipe.detail, '导入丁')
  assert.equal(lineDing['规则号型'], '170/88A', '量体明细：导入丁规则号型=170/88A')
  assert.equal(lineDing['生效号型'], '170/88A', '量体明细：导入丁生效号型=170/88A')
  assert.equal(lineDing['是否覆写'], '否', '量体明细：导入丁未覆写')
  assert.equal(lineDing['状态'], '有效', '量体明细：导入丁状态=有效')
  assert.equal(lineDing['胸腰差(cm)'], '12', '量体明细：导入丁胸腰差=12（半厘米整数相减）')

  const lineJi = detailRowByName(pipe.detail, '导入己')
  assert.equal(lineJi['状态'], '无效行', '量体明细：身高越界的导入己=无效行')
  assert.match(String(lineJi['备注']), /身高/, '量体明细：无效行备注要带原因，便于定位到人')

  const lineBing = detailRowByName(pipe.detail, '手录丙')
  assert.equal(lineBing['特殊体型'], '加肥加大', '量体明细：手录丙特殊标记中文标签')

  // —— CSV 往返：下单表数量列回读仍是数字文本，行对行一致 ——
  const orderCsvBack = csvRows(pipe.orderRows)
  const backData = orderDataRows(orderCsvBack as (string | number)[][])
  assert.equal(backData.length, page.length, 'CSV 往返：数据行数与页面一致')
  assert.equal(backData.reduce((sum, item) => sum + Number(item.qty), 0), 7, 'CSV 往返：数量列可重新求和=7（Excel SUM 不失效）')

  // —— XLSX 往返：数值单元格真为数值类型 ——
  const book = readOurXlsx(await buildXlsxBytes(pipe.orderSheets))
  assert.equal(book[0].name, '下单汇总表', 'XLSX：sheet1 名=下单汇总表')
  const qtyCol = 4
  const headerRowIdx = book[0].rows.findIndex((row) => row.some((cell) => cell.value === '数量'))
  assert.ok(headerRowIdx >= 0, 'XLSX：存在数量表头')
  let numericQty = 0
  let stringQty = 0
  for (let i = headerRowIdx + 1; i < book[0].rows.length; i += 1) {
    const cell = book[0].rows[i][qtyCol]
    if (!cell || cell.value === '') continue
    if (cell.type === 'n') numericQty += Number(cell.value)
    else stringQty += 1
  }
  assert.equal(stringQty, 0, 'XLSX：数量列不得混入文本单元格（数字与文本不能混）')
  assert.equal(numericQty, 7 + 7 + 7, 'XLSX：数量列全部为数值（明细 7 + 合计 7 + 有效人数 7），Excel 可直接求和')

  // 号型列必须是文本（170/88A 若被 Excel 当数字会坏掉）
  const codeCell = book[0].rows[headerRowIdx + 1][1]
  assert.equal(codeCell.type, 's', 'XLSX：号型列必须是文本类型')

  // 量体明细 XLSX 行数 = 人数 + 表头
  const detailBook = readOurXlsx(await buildXlsxBytes(pipe.detailSheets))
  assert.equal(detailBook[0].rows.length, project.persons.length + 1, 'XLSX：量体明细行数=人数+表头')
  const specialBook = detailBook[1]
  assert.equal(specialBook.rows.length, 2, 'XLSX：特殊清单=表头+手录丙 1 行')

  // 手录甲 sanity：result 已由 runMerge 写入
  assert.equal(manA.result?.sizeCode, '170/88A', '归并阶段：手录甲 170/88A')})

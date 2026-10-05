/**
 * 导出文件格式契约：
 * - 数字与文本不混：下单表的序号 / 数量在 XLSX 里必须是数值格（<v>），
 *   标签必须是文本格（inlineStr）；同一列全列类型一致；CSV 里数量是不带引号的裸数字，
 *   回读后能按整数解析且与页面一致。
 * - 带逗号、引号、换行的单元格：CSV 按 RFC 加引号与双写转义，XLSX 按 XML 实体转义，
 *   两条路都必须无损往返。
 */
import { test } from 'node:test'
import { makeCheck } from './helpers/check'
import { addPerson, makeProject } from './helpers/factory'
import { runChain } from './helpers/chain'
import { BUILTIN_RULES } from '../../src/logic/sizeRules'
import { parseDelimitedText, toCsvText } from '../../src/logic/csv'
import { buildXlsxBlob } from '../../src/logic/xlsx'
import { readXlsxBlob } from './helpers/xlsxReader'

const rule = BUILTIN_RULES.find((item) => item.version === 'v1.0.0')!

test('导出格式：CSV 带 BOM，逗号 / 引号 / 换行单元格无损往返', () => {
  const check = makeCheck('导出文件')
  const tricky = [
    ['高一(3)班,重点', '他说"你好"', '两行\n文本', 'CRLF\r\n文本', 512, '普通', '']
  ]
  const csv = toCsvText(tricky)

  check.eq(csv.charCodeAt(0), 0xfeff, 'CSV 以 BOM 开头（Excel 双击正确识别中文）')
  check.match(csv, /"高一\(3\)班,重点"/, '含逗号的单元格必须加引号')
  check.match(csv, /"他说""你好"""/, '单元格内引号必须双写转义')
  check.match(csv, /"两行\n文本"/, '含换行的单元格必须加引号')
  check.match(csv, /\r\n$/, '行尾 CRLF')
  check.match(csv, /,512,/, '数字单元格是不带引号的裸数字')

  const back = parseDelimitedText(csv)
  check.deepEq(
    back,
    [['高一(3)班,重点', '他说"你好"', '两行\n文本', 'CRLF\r\n文本', '512', '普通', '']],
    'CSV 往返后逐格一致（数字回读为文本 "512"，由导入侧按列解析回数值）'
  )
})

test('导出格式：XLSX 里数字是数值格、文本是文本格，特殊字符无损', async () => {
  const check = makeCheck('导出文件')
  const sheets = await readXlsxBlob(
    buildXlsxBlob([
      {
        name: '契约',
        rows: [
          ['号型', '数量', '备注'],
          ['170/88A', 12, '张"<三>&'],
          ['175/92B', 3, '第一行\n第二行,带逗号']
        ]
      }
    ])
  )
  const rows = sheets[0].rows
  check.eq(rows[1][0].isNumber, false, '号型列必须是文本格')
  check.eq(rows[1][1].isNumber, true, '数量列必须是数值格（数字不存成文本）')
  check.eq(rows[1][1].value, '12', '数量值')
  check.eq(rows[1][2].value, '张"<三>&', 'XML 特殊字符（引号 / 尖括号 / &）无损往返')
  check.eq(rows[2][2].value, '第一行\n第二行,带逗号', '换行与逗号在 XLSX 单元格内无损')
  check.eq(rows[2][1].isNumber, true, '第二行数量列仍是数值格（同列类型一致）')
})

test('导出格式：下单表全链路 —— 数量列数值型、标签列文本型、全列不混型', async () => {
  const check = makeCheck('导出文件')
  const project = makeProject({ ruleVersion: rule.version })
  addPerson(project, rule, { name: '格式甲', heightCm: 170, chestCm: 88, waistCm: 72, sourceRow: 1 })
  addPerson(project, rule, { name: '格式乙', heightCm: 170, chestCm: 88, waistCm: 72, sourceRow: 2 })
  addPerson(project, rule, { name: '格式丙', gender: 'female', heightCm: 160, chestCm: 84, waistCm: 66, sourceRow: 3 })
  const chain = runChain(project, rule)

  // 行模型层：序号与数量必须是 number，标签必须是 string
  const itemRows = chain.orderRows.filter((row) => typeof row[0] === 'number')
  check.ok(itemRows.length > 0, '下单表应有明细行')
  for (const row of itemRows) {
    check.eq(typeof row[0], 'number', `序号列应为 number（行：${row.join('|')}）`)
    check.eq(typeof row[4], 'number', `数量列应为 number（行：${row.join('|')}）`)
    check.eq(typeof row[1], 'string', '号型列应为 string')
  }

  // 文件层（XLSX）：逐格回读验证类型
  const book = await readXlsxBlob(buildXlsxBlob(chain.orderXlsxSheets))
  const sheet = book[0].rows
  const headerIndex = sheet.findIndex((row) => row[0]?.value === '序号')
  check.ok(headerIndex >= 0, '找到下单表表头')
  for (const row of sheet.slice(headerIndex + 1)) {
    if (row.length === 0 || row[0].value === '') continue
    check.eq(row[0].isNumber, true, `序号列在 XLSX 里必须是数值格（第 ${sheet.indexOf(row) + 1} 行）`)
    check.eq(row[4].isNumber, true, `数量列在 XLSX 里必须是数值格（第 ${sheet.indexOf(row) + 1} 行）`)
    check.eq(row[1].isNumber, false, '号型列必须是文本格')
  }

  // 文件层（CSV）：数量列回读可解析为同一个整数
  const parsed = parseDelimitedText(chain.orderCsv)
  const csvHeaderIndex = parsed.findIndex((row) => row[0] === '序号')
  for (const row of parsed.slice(csvHeaderIndex + 1)) {
    if (row[0] === '') continue
    const qty = Number(row[4])
    check.ok(Number.isInteger(qty), `CSV 数量列可解析为整数（行：${row.join('|')}）`)
  }
  const totalQty = chain.summary.totals.accountedQty
  const csvTotal = parsed.find((row) => row[1] === '合计')!
  check.eq(Number(csvTotal[4]), totalQty, 'CSV 合计行数量 = 页面已归账套数')
})

test('导出格式：明细表的测量列全列类型一致（显示格式化文本），空单元格不占位', async () => {
  const check = makeCheck('导出文件')
  const project = makeProject({ ruleVersion: rule.version })
  addPerson(project, rule, { name: '齐全', heightCm: 167.5, weightKg: 60, chestCm: 88, waistCm: 72, sourceRow: 5 })
  addPerson(project, rule, { name: '缺重', heightCm: 170, weightKg: null, chestCm: 88, waistCm: 72, sourceRow: null })
  const chain = runChain(project, rule)

  const book = await readXlsxBlob(buildXlsxBlob(chain.detailXlsxSheets))
  const rows = book[0].rows
  const dataRows = rows.slice(1).filter((row) => row.length > 0)
  check.eq(dataRows.length, 2, '明细两行')

  // 身高列：两人都是文本格 '167.5' / '170'（显示格式化），全列类型一致
  check.eq(dataRows[0][5].isNumber, false, '身高列是显示格式化文本格')
  check.eq(dataRows[0][5].value, '167.5', '半厘米身高显示为 167.5')
  check.eq(dataRows[1][5].isNumber, false, '身高列全列类型一致（不混数值格）')
  check.eq(dataRows[1][5].value, '170', '整数身高不带小数点')

  // 缺体重的单元格：应为空（缺省），而不是字符串 'null' / 'undefined'
  check.eq(dataRows[1][6]?.value ?? '', '', '缺测的体重为空单元格')
  // 行号列：第一人有行号（数值格），第二人无行号（空单元格），不允许出现 'null' 文本
  check.eq(dataRows[0][0].isNumber, true, '导入行号是数值格')
  check.eq(dataRows[0][0].value, '5', '行号值与录入一致')
  check.eq(dataRows[1][0]?.value ?? '', '', '无行号为空单元格而非 "null" 文本')
})

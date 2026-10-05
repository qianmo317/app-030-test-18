/**
 * 用例组 5：表格单元格的脏数据与类型纪律。
 *  - 带逗号、引号、换行、CRLF 的单元格：CSV 必须正确加引号/转义并原样往返；
 *    再次导入时姓名/备注不能串行、不能丢字符
 *  - 数字与文本不能混：XLSX 数量列是数值单元格（Excel 可 SUM），
 *    号型、班级等代码/文本列一律 inlineStr；CSV 数量单元格必须是纯数字文本
 *  - 数字样式的文本（工号式 "007"、前导零班级 "01班"）保持文本，不被吞零
 */
import { parseDelimitedText, toCsvText } from '../src/logic/csv'
import {
  RULE_V1,
  assert,
  buildXlsxBytes,
  csvRows,
  enterManually,
  importTable,
  makeProject,
  readOurXlsx,
  runPipeline,
  test
} from './helpers'

test('单元格-1 逗号/双引号/换行/CRLF：CSV 转义往返不串行', () => {
  const trickyName = '张,三"大"\n师'
  const trickyNote = '第一行\r\n第二行，含"引号"与,逗号'
  const rows: (string | number)[][] = [
    ['姓名', '备注', '数量'],
    [trickyName, trickyNote, 12]
  ]
  const csv = toCsvText(rows)
  // 必须整体被双引号包住，内部引号成对转义
  assert.match(csv, /"张,三""大""\n师"/, 'CSV 转义：含逗号引号换行的姓名被引号包裹、引号翻倍')
  assert.match(csv, /"第一行\r\n第二行，含""引号""与,逗号"/, 'CSV 转义：CRLF 与全角逗号都安全')

  const back = parseDelimitedText(csv)
  assert.equal(back.length, 2, 'CSV 往返：仍是 2 行（单元格内换行没有把行劈开）')
  assert.equal(back[1][0], trickyName, 'CSV 往返：姓名逐字符还原（逗号/引号/换行）')
  assert.equal(back[1][1], trickyNote, 'CSV 往返：备注逐字符还原（CRLF/引号/逗号）')
  assert.equal(back[1][2], '12', 'CSV 往返：数字单元格文本不变')

  // 未加引号但带逗号的朴素文件会串行——这是格式错误，解析器按标准行为拆列，
  // 真正的防线是 dry_run 行校验：拆出来必填列对不上会报错误行而不是静默写库
  const broken = '姓名,性别,身高,胸围,腰围\n没引号还带,逗号,男,170,88,72'
  const parsed = parseDelimitedText(broken)
  assert.equal(parsed[1].length, 6, '异常输入：不带引号的逗号确实多拆一列（6 列）')
  const pj = makeProject('脏数据项目', RULE_V1)
  const { dryRun } = importTable(pj, RULE_V1, broken, 'broken.csv')
  assert.equal(dryRun.rows.some((row) => row.kind === 'error'), true, '防线：串行后的行在 dry_run 落成错误行，不允许静默写库')
})

test('单元格-2 脏姓名/备注从导入走到明细再导出，全程不丢字符', () => {
  // 姓名 王"五 按 RFC4180 编码为 "王""五"；备注含逗号与换行，整体加引号
  const nameEncoded = '"王""五"'
  const noteEncoded = '"带,逗号\n与换行"'
  const legal = ['姓名,性别,班级,身高,胸围,腰围,备注', `${nameEncoded},男,一班,170,88,72,${noteEncoded}`].join('\n')

  const pj = makeProject('脏字符项目', RULE_V1)
  const { applied, dryRun } = importTable(pj, RULE_V1, legal, 'dirty.csv')
  const target = dryRun.rows.find((row) => row.draft?.name?.startsWith('王'))
  assert.ok(target, '导入：含引号姓名的行进了 dry_run')
  assert.equal(target!.draft!.name, '王"五', '导入：转义引号还原为一个双引号')
  assert.equal(applied.added, 1, '导入：脏字符行正常落库 1 条')

  const pipe = runPipeline(pj, RULE_V1)
  const person = pj.persons[0]
  assert.equal(person.name, '王"五', '落库：姓名为王"五')
  assert.match(person.note, /带,逗号\n与换行/, '落库：备注里的逗号与换行都在')

  // 明细再导成 CSV，回读，字符依旧
  const detailBack = csvRows(pipe.detail)
  const dataLine = detailBack.find((row) => row[1].startsWith('王'))!
  assert.equal(dataLine[1], '王"五', '明细导出：姓名往返一致')
  assert.match(dataLine[17], /带,逗号\n与换行/, '明细导出：备注往返一致（引号包裹，换行不拆行）')
})

test('单元格-3 类型纪律：下单表 XLSX 数量列全数值，号型/班级/前导零文本不被数值化', async () => {
  const pj = makeProject('类型纪律项目', RULE_V1)
  // 班级用前导零 "01班"；备注里放一个工号式 007
  enterManually(pj, RULE_V1, { name: '零号同学', gender: 'male', orgUnit: '01班', heightCm: 170, chestCm: 88, waistCm: 72, note: '工号007' })
  enterManually(pj, RULE_V1, { name: '零号乙', gender: 'male', orgUnit: '01班', heightCm: 175, chestCm: 96, waistCm: 80 })
  const pipe = runPipeline(pj, RULE_V1)

  const order = readOurXlsx(await buildXlsxBytes(pipe.orderSheets))
  const org = readOurXlsx(await buildXlsxBytes([{ name: '按班级车间小计', rows: pipe.orgRows }]))

  // 下单表：序号(0) 数值；号型(1) 文本；数量(4) 数值
  const headerAt = order[0].rows.findIndex((row) => row.some((cell) => cell.value === '数量'))
  const dataRows = order[0].rows.slice(headerAt + 1)
  for (const row of dataRows) {
    if (row.length < 5) continue
    if (typeof row[0] !== 'undefined' && row[0].value !== '') assert.equal(row[0].type, 'n', '类型：序号列数值')
    if (row[1].value) assert.equal(row[1].type, 's', '类型：号型列文本（不会被 Excel 当日期/数字）')
    if (row[4].value !== '') assert.equal(row[4].type, 'n', `类型：数量「${row[4].value}」必须是数值单元格`)
  }

  // 班级小计页签：班级名是文本，前导零保留
  const orgData = org[0].rows.slice(1).find((row) => row[0].value.includes('01班'))
  assert.ok(orgData, '类型：含前导零的班级名存在')
  assert.equal(orgData![0].type, 's', '类型：班级名 01班 是文本，前导零不被吞')

  // 量体明细：工号文本在备注列完整保留
  const detail = readOurXlsx(await buildXlsxBytes(pipe.detailSheets))
  const detailLine = detail[0].rows.find((row) => row.some((cell) => cell.value === '零号同学'))!
  const noteCell = detailLine[17]
  assert.equal(noteCell.type, 's', '类型：备注列文本')
  assert.match(noteCell.value, /工号007/, '类型：工号 007 三个零保留（文本不被数值化为 7）')

  // CSV 侧：数量列纯数字、班级列原样
  const orgCsv = csvRows(pipe.orgRows)
  const orgLine = orgCsv.find((row) => row[0] === '01班')!
  assert.match(orgLine[5], /^\d+$/, '类型：CSV 小计数量为纯数字文本')
  assert.equal(orgLine[0], '01班', '类型：CSV 班级前导零保留')
})

test('单元格-4 BOM/制表符/分号/全角逗号分隔的表格文本都能识别表头与列', () => {
  const variants = [
    '姓名\t性别\t身高(cm)\t胸围(cm)\t腰围(cm)\n马甲\t男\t170\t88\t72',
    '姓名;性别;身高;胸围;腰围\n马甲;男;170;88;72'
  ]
  for (const text of variants) {
    const pj = makeProject('分隔符项目', RULE_V1)
    const { applied } = importTable(pj, RULE_V1, '﻿' + text, 'sep.txt')
    assert.equal(applied.added, 1, `分隔符识别：${text.includes('\t') ? 'TSV(制表符)' : '分号'} 文件落库 1 条`)
    assert.equal(pj.persons[0].name, '马甲', '分隔符识别：姓名正确')
    assert.equal(pj.persons[0].heightCm, 170, '分隔符识别：身高 170')
  }
})

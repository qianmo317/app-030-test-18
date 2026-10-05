/**
 * 用例组 7：大批量（5000 人）下整条链的确定性与耗时。
 *  - 同一份输入跑两遍：分档表、单位小计、明细行、导出字节级数据必须逐行相同
 *  - 归并耗时预算（规格书 §8：5000 人 < 200ms）在本机环境给 CI 余量，断言 < 1000ms 硬门槛
 *  - 5000 行 CSV 解析+dry_run 校验 < 2000ms
 *  - 不依赖 Map 插入顺序之外的随机：姓名/尺寸由确定性伪随机生成，不调用 Date.now/Math.random 造数据
 */
import { parseDelimitedText, toCsvText } from '../src/logic/csv'
import {
  RULE_V1,
  assert,
  buildXlsxBytes,
  csvRows,
  importTable,
  makeProject,
  orderDataRows,
  readOurXlsx,
  runPipeline,
  test,
  type Pipeline
} from './helpers'

const N = 5000

/** 确定性 LCG：同一颗种子永远生成同一批人 */
function lcg(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 0x100000000
  }
}

function buildBigCsv(seed = 20261005): string {
  const rand = lcg(seed)
  const orgs = ['高一(1)班', '高一(2)班', '高一(3)班', '高一(4)班', '高一(5)班', '高一(6)班', '高一(7)班', '高一(8)班']
  const heights = [155, 157.5, 160, 162.5, 165, 167.5, 170, 172.5, 175, 177.5, 180, 182.5, 185]
  const chests = [80, 82, 84, 86, 88, 90, 92, 94, 96, 98, 100, 102]
  // 型别区间端点（半厘米精度下相邻端点无间隙），男女各取一套，保证全批可归并
  const diffsMale = [2, 6, 7, 11, 12, 16, 17, 22]
  const diffsFemale = [4, 8, 9, 13, 14, 18, 19, 24]
  const lines = ['姓名,性别,班级,批次,身高,体重,胸围,腰围,特殊体型,备注']
  let special = 0
  for (let i = 0; i < N; i += 1) {
    const male = rand() > 0.5
    const height = heights[Math.floor(rand() * heights.length)]
    const chest = chests[Math.floor(rand() * chests.length)]
    const diffPool = male ? diffsMale : diffsFemale
    const diff = diffPool[Math.floor(rand() * diffPool.length)]
    const waist = chest - diff
    const org = orgs[Math.floor(rand() * orgs.length)]
    const isSpecial = i % 337 === 0
    if (isSpecial) special += 1
    lines.push(
      [
        `批量${String(i + 1).padStart(4, '0')}`,
        male ? '男' : '女',
        org,
        '秋装',
        String(height),
        String(50 + Math.floor(rand() * 40)),
        String(chest),
        String(waist),
        isSpecial ? 'PLUS' : '',
        ''
      ].join(',')
    )
  }
  assert.ok(special > 0, '造数：每批至少有特殊体型（337 行一个）')
  return lines.join('\n')
}

function snapshot(pipe: Pipeline): unknown {
  return {
    regular: pipe.summary.regularRows,
    special: pipe.summary.specialRows,
    totals: pipe.summary.totals,
    org: pipe.summary.byOrgUnit.map((group) => [group.orgUnit, group.validCount, group.regularQty, group.specialQty]),
    // 下单表前 6 行是 meta（含项目名/生成时间），确定性只比数据段
    orderData: orderDataRows(pipe.orderRows),
    orgRows: pipe.orgRows,
    // 明细只比数据列（序号/姓名/规则/生效/覆写/状态），不含项目名等元信息
    detail: pipe.detail.slice(1).map((row) => [row[0], row[1], row[10], row[11], row[12], row[16]])
  }
}

test(`大批量 ${N} 人：导入解析校验耗时、归并耗时、守恒`, () => {
  const csv = buildBigCsv()

  // 解析 + dry_run（走真实导入函数）
  const pj = makeProject('五千人秋装', RULE_V1, ['秋装'])
  const parseStart = performance.now()
  const { applied } = importTable(pj, RULE_V1, csv, 'big5000.csv')
  const parseMs = Math.round(performance.now() - parseStart)

  assert.equal(pj.persons.length, N, '大批量：落库正好 5000')
  assert.equal(applied.added + (applied.invalid ?? 0), N, '大批量：全部落库（构造保证无无效行）')
  assert.equal(applied.skipped, 0, '大批量：没有错误行')
  assert.ok(parseMs < 2000, `大批量：解析+校验 ${parseMs}ms 应 < 2000ms（规格书预算）`)

  // 归并 + 汇总耗时（runMerge 自身的计时与整链计时都报）
  const fullStart = performance.now()
  const pipe = runPipeline(pj, RULE_V1)
  const fullMs = Math.round(performance.now() - fullStart)
  console.log(`    [perf] 5000 行 CSV 解析+dry_run = ${parseMs}ms；runMerge 自报 = ${pipe.mergeMs}ms；归并+汇总+三处建模 = ${fullMs}ms`)

  assert.ok(pipe.mergeMs < 200, `大批量：runMerge ${pipe.mergeMs}ms 应 < 200ms（规格书硬指标，当前环境应稳定达标）`)
  assert.ok(fullMs < 1000, `大批量：整链建模 ${fullMs}ms 应 < 1000ms（CI 余量）`)
  assert.equal(pipe.summary.totals.validRows, N, '大批量：有效 5000')
  assert.equal(pipe.summary.totals.accountedQty, N, '大批量：归并 5000 套')
  assert.equal(pipe.summary.conserved, true, '大批量：守恒成立')
  assert.equal(pipe.summary.unmerged.length, 0, '大批量：无未归并行')
  assert.ok(pipe.summary.totals.specialQty > 0, '大批量：特殊单列非零')

  // 分档之和=5000；单位小计之和=5000
  const rowSum = pipe.summary.allRows.reduce((sum, row) => sum + row.qty, 0)
  assert.equal(rowSum, N, '大批量：分档数量之和 5000')
  const orgSum = pipe.summary.byOrgUnit.reduce((sum, group) => sum + group.regularQty + group.specialQty, 0)
  assert.equal(orgSum, N, '大批量：八个班小计之和 5000')

  // 三处呈现总量一致
  assert.equal(orderDataRows(pipe.orderRows).reduce((sum, row) => sum + row.qty, 0), N, '大批量：下单表数量之和 5000')
})

test(`大批量 ${N} 人：同一份输入跑两遍，结论逐行相同（确定性）`, async () => {
  const csv = buildBigCsv()
  const pj1 = makeProject('五千人甲', RULE_V1, ['秋装'])
  importTable(pj1, RULE_V1, csv, 'big5000.csv')
  const pipe1 = runPipeline(pj1, RULE_V1, '测试员', new Date('2026-10-05T09:00:00'))

  // 第二遍：全新项目、重新解析同一份文本
  const pj2 = makeProject('五千人乙', RULE_V1, ['秋装'])
  importTable(pj2, RULE_V1, csv, 'big5000.csv')
  const pipe2 = runPipeline(pj2, RULE_V1, '测试员', new Date('2026-10-05T09:00:00'))

  // 逐人（按确定性姓名）比对生效号型
  const byName2 = new Map(pj2.persons.map((person) => [person.name, person]))
  for (const person of pj1.persons) {
    const other = byName2.get(person.name)
    assert.ok(other, `确定性：${person.name} 在第二遍不存在`)
    assert.equal(other!.result?.sizeCode, person.result?.sizeCode, `确定性：${person.name} 两遍号型不一致`)
    assert.equal(other!.result?.fit, person.result?.fit, `确定性：${person.name} 两遍型别不一致`)
  }

  // 汇总快照深比
  assert.deepEqual(snapshot(pipe2), snapshot(pipe1), '确定性：分档/小计/合计/明细数据列两遍完全一致')

  // 导出文本逐行相同：去掉前 6 行 meta（项目名/生成时间）后，数据段字节级一致
  const dataSlice = (text: string) => text.split('\r\n').slice(6).join('\r\n')
  assert.equal(dataSlice(toCsvText(pipe2.orderRows)), dataSlice(toCsvText(pipe1.orderRows)), '确定性：下单表 CSV 数据段字节级一致')
  const detailBack1 = csvRows(pipe1.detail)
  const detailBack2 = csvRows(pipe2.detail)
  assert.deepEqual(detailBack2, detailBack1, '确定性：量体明细 CSV 回读逐行一致')

  // XLSX 单元格内容两遍相同（zip 头含 DOS 时间戳，只比单元格不比字节；前 7 行 meta 跳过）
  const book1 = readOurXlsx(await buildXlsxBytes(pipe1.orderSheets))
  const book2 = readOurXlsx(await buildXlsxBytes(pipe2.orderSheets))
  assert.equal(book2.length, book1.length, '确定性：xlsx sheet 数一致')
  for (let s = 0; s < book1.length; s += 1) {
    assert.equal(book2[s].rows.length, book1[s].rows.length, `确定性：sheet${s + 1} 行数一致`)
    const startAt = s === 0 ? 7 : 0 // sheet1 前 6 行 meta + 1 行空行
    for (let r = startAt; r < book1[s].rows.length; r += 1) {
      assert.deepEqual(
        book2[s].rows[r].map((cell) => `${cell.type}:${cell.value}`),
        book1[s].rows[r].map((cell) => `${cell.type}:${cell.value}`),
        `确定性：sheet${s + 1} 第 ${r + 1} 行单元格（含类型）一致`
      )
    }
  }
})

test(`大批量 ${N} 人：解析器本身吞吐（不经过 dry_run，纯 parse）`, () => {
  const csv = buildBigCsv()
  const start = performance.now()
  const rows = parseDelimitedText(csv)
  const ms = Math.round(performance.now() - start)
  console.log(`    [perf] parseDelimitedText 5001 行纯解析 = ${ms}ms`)
  assert.equal(rows.length, N + 1, '纯解析：行数 5001（含表头）')
  assert.ok(ms < 1000, `纯解析：${ms}ms 应 < 1000ms`)
})

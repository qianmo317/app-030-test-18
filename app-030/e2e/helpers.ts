/**
 * e2e 公共工具：
 * - 手工录入 / 表格导入走真实 createPersonFromDraft / applyImport
 * - 三处呈现（页面汇总 / 下单表与打印稿 / 量体明细）共用的对账原语
 * - xlsx 读回（我们自己写的 zip 是 stored，直接解 zip 条目即可，不引第三方库）
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Gender, Person, Project, SizeRule } from '../src/logic/types'
import { BUILTIN_RULES } from '../src/logic/sizeRules'
import {
  analyzeDraft,
  findDuplicateIds,
  makePersonId,
  type PersonDraft
} from '../src/logic/analyze'
import { buildDryRun, applyImport, guessMapping, detectHeaderRow, type DryRun } from '../src/logic/importPlan'
import { runMerge, buildSummary, type Summary } from '../src/logic/merge'
import {
  buildOrderSheet,
  canExportOrderSheet,
  detailRows,
  orderSheetToRows,
  orgUnitSheetToRows,
  specialRows,
  type ExportContext
} from '../src/logic/exporter'
import { parseDelimitedText, toCsvText } from '../src/logic/csv'
import { buildXlsxBlob, type Sheet } from '../src/logic/xlsx'

export const RULE_V1 = BUILTIN_RULES.find((rule) => rule.version === 'v1.0.0')!
export const RULE_V1_NEAREST: SizeRule = { ...RULE_V1, version: 'v-test-nearest', label: '测试规则：边界就近', boundaryRule: 'nearest' }
export const RULE_V1_1 = BUILTIN_RULES.find((rule) => rule.version === 'v1.1.0')!
export const ALL_RULES: SizeRule[] = [RULE_V1, RULE_V1_1]

let projectSeq = 0

export function makeProject(name = 'e2e 项目', rule: SizeRule = RULE_V1, batches: string[] = ['春装']): Project {
  projectSeq += 1
  const now = Date.now()
  return {
    id: `e2e_prj_${projectSeq}`,
    name,
    kind: 'school',
    ruleVersion: rule.version,
    batches,
    persons: [],
    imports: [],
    createdAt: now,
    updatedAt: now
  }
}

/** 与页面 store.getRule 同一行为：认不出版本回落首个内置规则 */
export function ruleFor(project: Project, extra: SizeRule[] = []): SizeRule {
  const pool = [RULE_V1, RULE_V1_1, RULE_V1_NEAREST, ...extra]
  return pool.find((rule) => rule.version === project.ruleVersion) ?? RULE_V1
}

export type ManualInput = {
  name: string
  gender?: Gender
  orgUnit?: string
  batch?: string
  heightCm?: number | null
  weightKg?: number | null
  chestCm?: number | null
  waistCm?: number | null
  specialFlag?: string | null
  note?: string
  sourceRow?: number | null
}

/** 模拟量体录入页「回车存下一条」：走与 MeasureView 完全相同的建人路径 */
export function enterManually(project: Project, rule: SizeRule, input: ManualInput): Person {
  const draft: PersonDraft = {
    name: input.name,
    gender: input.gender ?? 'male',
    orgUnit: input.orgUnit ?? '高一(1)班',
    batch: input.batch ?? project.batches[0] ?? '未分批',
    heightCm: input.heightCm === undefined ? null : input.heightCm,
    weightKg: input.weightKg === undefined ? null : input.weightKg,
    chestCm: input.chestCm === undefined ? null : input.chestCm,
    waistCm: input.waistCm === undefined ? null : input.waistCm,
    specialFlag: input.specialFlag ?? null,
    note: input.note ?? '',
    sourceRow: input.sourceRow ?? project.persons.length + 1,
    source: 'manual'
  }
  const outcome = analyzeDraft(draft, rule)
  const duplicated = findDuplicateIds(project.persons, draft)
  const person: Person = {
    id: makePersonId(),
    name: draft.name.trim(),
    gender: draft.gender ?? 'male',
    orgUnit: draft.orgUnit.trim(),
    batch: draft.batch,
    heightCm: draft.heightCm ?? 0,
    weightKg: draft.weightKg,
    chestCm: draft.chestCm ?? 0,
    waistCm: draft.waistCm ?? 0,
    specialFlag: draft.specialFlag,
    note: draft.note,
    status: outcome.status,
    statusReason: outcome.statusReason,
    anomaly: outcome.anomaly,
    needsConfirm: outcome.needsConfirm || duplicated.length > 0,
    possibleDuplicateOf: duplicated.length > 0 ? `既有行「${duplicated[0]}」` : null,
    sourceRow: draft.sourceRow,
    source: 'manual',
    result: null,
    createdAt: Date.now()
  }
  project.persons.push(person)
  return person
}

/** 模拟导入页：解析文本 → 表头识别 → dry_run → 正式导入（同一文件指纹幂等由调用方判定，同页面） */
export function importTable(
  project: Project,
  rule: SizeRule,
  text: string,
  fileName = '量体表.csv',
  fileSize = text.length
): { dryRun: DryRun; applied: ReturnType<typeof applyImport>; alreadyImported: boolean } {
  const rows = parseDelimitedText(text)
  const fingerprint = `${fileName}|${fileSize}|${text.length}`
  const alreadyImported = project.imports.some((record) => record.fingerprint === fingerprint)
  const headerIndex = detectHeaderRow(rows)
  if (headerIndex < 0) throw new Error('表头未识别')
  const mapping = guessMapping(rows[headerIndex])
  const dataRows = rows
    .slice(headerIndex + 1)
    .map((cells, index) => ({ cells, lineNo: headerIndex + index + 2 }))
    .filter((row) => row.cells.some((cell) => cell !== ''))
  const dryRun = buildDryRun(dataRows, mapping, project, rule, fileName, fingerprint)
  const applied = alreadyImported ? { added: 0, updated: 0, invalid: 0, skipped: 0 } : applyImport(project, dryRun, rule)
  return { dryRun, applied, alreadyImported }
}

/** 整条链的一次完整跑批：归并 → 汇总 → 三处呈现模型 */
export type Pipeline = {
  rule: SizeRule
  mergeMs: number
  summary: Summary
  ctx: ExportContext
  orderRows: (string | number)[][]
  orgRows: (string | number)[][]
  detail: (string | number)[][]
  special: (string | number)[][]
  orderSheets: Sheet[]
  detailSheets: Sheet[]
}

export function runPipeline(project: Project, rule = ruleFor(project), operator = '测试员', at = new Date('2026-10-05T09:00:00')): Pipeline {
  const mergeMs = runMerge(project, rule).durationMs
  const summary = buildSummary(project, rule)
  const ctx: ExportContext = { project, rule, summary, operator, generatedAt: at }
  const order = buildOrderSheet(ctx)
  const orderRows = orderSheetToRows(order)
  const orgRows = orgUnitSheetToRows(order)
  const detail = detailRows(ctx)
  const special = specialRows(ctx)
  const orderSheets = [
    { name: '下单汇总表', rows: orderRows },
    { name: '按班级车间小计', rows: orgRows }
  ]
  const detailSheets = [
    { name: '量体明细', rows: detail },
    { name: '特殊体型清单', rows: special }
  ]
  return { rule, mergeMs, summary, ctx, orderRows, orgRows, detail, special, orderSheets, detailSheets }
}

/** 页面表格行（号型|性别|类型|数量），模拟 SummaryView 渲染时取的那组数据 */
export function pageOrderView(summary: Summary): { code: string; gender: string; isSpecial: boolean; qty: number }[] {
  return summary.allRows.map((row) => ({
    code: row.sizeCode,
    gender: row.gender === 'male' ? '男' : '女',
    isSpecial: row.isSpecial,
    qty: row.qty
  }))
}

/** 打印稿 / 导出预览表格行（ExportView 的 print-sheet 与预览共用 orderSheet.items） */
export function printOrderView(ctx: ExportContext): { label: string; gender: string; kind: string; qty: number }[] {
  return buildOrderSheet(ctx).items.map((item) => ({
    label: item.sizeLabel,
    gender: item.gender,
    kind: item.kind,
    qty: item.qty
  }))
}

/** 从下单汇总表二维行里取「序号/号型/性别/类型/数量」数据段（跳过 meta 与表头） */
export function orderDataRows(rows: (string | number)[][]): { index: number; label: string; gender: string; kind: string; qty: number }[] {
  const headerAt = rows.findIndex((row) => row[0] === '序号')
  const out: { index: number; label: string; gender: string; kind: string; qty: number }[] = []
  for (let i = headerAt + 1; i < rows.length; i += 1) {
    const row = rows[i]
    if (typeof row[1] === 'string' && (row[1] === '合计' || row[1] === '有效人数')) continue
    if (row.length < 5 || row[0] === '') continue
    out.push({
      index: Number(row[0]),
      label: String(row[1]),
      gender: String(row[2]),
      kind: String(row[3]),
      qty: Number(row[4])
    })
  }
  return out
}

/** 量体明细里按姓名定位一行（失败信息直接点到哪个人） */
export function detailRowByName(detail: (string | number)[][], name: string): Record<string, string | number> {
  const header = detail[0] as string[]
  const line = detail.slice(1).find((row) => row[1] === name)
  assert.ok(line, `量体明细中找不到「${name}」——明细导出阶段对不上`)
  const record: Record<string, string | number> = {}
  header.forEach((key, index) => {
    record[key] = line[index] ?? ''
  })
  return record
}

/* ------------------------------ 覆写（同 MergeView.submitOverride） ------------------------------ */

export function applyManualOverride(person: Person, rule: SizeRule, sizeCode: string, by: string, reason: string): void {
  person.result = {
    sizeCode,
    ruleSizeCode: person.result?.ruleSizeCode ?? '',
    fit: person.result?.fit ?? null,
    ruleVersion: rule.version,
    manualOverride: { sizeCode, by, reason, at: 1_759_000_000_000 }
  }
}

/* ------------------------------ xlsx 读回（stored zip） ------------------------------ */

export async function buildXlsxBytes(sheets: Sheet[]): Promise<Uint8Array> {
  const blob = buildXlsxBlob(sheets)
  return new Uint8Array(await blob.arrayBuffer())
}

type ZipEntry = { name: string; start: number; size: number; method: number }

export function readStoredZip(data: Uint8Array): Map<string, Uint8Array> {
  const entries = new Map<string, ZipEntry>()
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  let eocd = -1
  for (let i = data.length - 22; i >= 0 && i >= data.length - 66000; i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i
      break
    }
  }
  assert.ok(eocd >= 0, 'xlsx 读回失败：没有 ZIP EOCD')
  const total = view.getUint16(eocd + 10, true)
  let pointer = view.getUint32(eocd + 16, true)
  for (let n = 0; n < total; n += 1) {
    assert.equal(view.getUint32(pointer, true), 0x02014b50, 'xlsx 读回失败：中央目录头错误')
    const method = view.getUint16(pointer + 10, true)
    const compressedSize = view.getUint32(pointer + 20, true)
    const nameLen = view.getUint16(pointer + 28, true)
    const extraLen = view.getUint16(pointer + 30, true)
    const commentLen = view.getUint16(pointer + 32, true)
    const localOffset = view.getUint32(pointer + 42, true)
    const name = new TextDecoder().decode(data.subarray(pointer + 46, pointer + 46 + nameLen))
    entries.set(name, { name, start: localOffset, size: compressedSize, method })
    pointer += 46 + nameLen + extraLen + commentLen
  }

  const files = new Map<string, Uint8Array>()
  for (const entry of entries.values()) {
    assert.equal(view.getUint32(entry.start, true), 0x04034b50, `xlsx 读回失败：${entry.name} 本地头错误`)
    const nameLen = view.getUint16(entry.start + 26, true)
    const extraLen = view.getUint16(entry.start + 28, true)
    assert.equal(entry.method, 0, `测试只解 stored zip，${entry.name} 却用了压缩`)
    const contentStart = entry.start + 30 + nameLen + extraLen
    files.set(entry.name, data.subarray(contentStart, contentStart + entry.size))
  }
  return files
}

const ENTITY: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'"
}

function unescapeXml(text: string): string {
  return text.replace(/&(amp|lt|gt|quot|apos);/g, (match) => ENTITY[match] ?? match)
}

export type ReadCell = { value: string; type: 'n' | 's' }

export type ReadSheet = { name: string; rows: ReadCell[][] }

/** 读回我们自己写的 xlsx：取工作簿里 sheet 的登记顺序，解析 inlineStr / 数值单元格 */
export function readOurXlsx(data: Uint8Array): ReadSheet[] {
  const files = readStoredZip(data)
  const dec = new TextDecoder()
  const workbookXml = dec.decode(files.get('xl/workbook.xml')!)
  const sheetNames = [...workbookXml.matchAll(/<sheet[^>]*name="([^"]+)"/g)].map((match) => unescapeXml(match[1]))
  const colIndexOf = (ref: string): number => {
    const letters = ref.replace(/[^A-Z]/gi, '')
    let index = 0
    for (const ch of letters) index = index * 26 + ch.toUpperCase().charCodeAt(0) - 64
    return index - 1
  }
  return sheetNames.map((name, index) => {
    const xml = dec.decode(files.get(`xl/worksheets/sheet${index + 1}.xml`)!)
    const rows: ReadCell[][] = []
    for (const rowMatch of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells: ReadCell[] = []
      for (const cellMatch of rowMatch[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = cellMatch[1]
        const inner = cellMatch[2] ?? ''
        const refMatch = /r="([A-Z]+\d+)"/.exec(attrs)
        const position = refMatch ? colIndexOf(refMatch[1]) : cells.length
        while (cells.length <= position) cells.push({ value: '', type: 's' })
        const isString = /t="inlineStr"/.test(attrs)
        if (isString) {
          const textMatch = /<t[^>]*>([\s\S]*?)<\/t>/.exec(inner)
          cells[position] = { value: unescapeXml(textMatch?.[1] ?? ''), type: 's' }
        } else if (inner.trim() !== '') {
          const numMatch = /<v>([^<]*)<\/v>/.exec(inner)
          cells[position] = { value: numMatch?.[1] ?? '', type: 'n' }
        } else {
          cells[position] = { value: '', type: 's' }
        }
      }
      rows.push(cells)
    }
    return { name, rows }
  })
}

/** CSV 回读为二维字符串（与导入同解析器，保证往返一致） */
export function csvRows(rows: (string | number)[][]): string[][] {
  return parseDelimitedText(toCsvText(rows))
}

export { assert, test, canExportOrderSheet }

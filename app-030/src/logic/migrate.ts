/**
 * 旧存档兼容层：IndexedDB 里早期版本写出的项目记录可能缺字段，
 * 直接交给归并 / 汇总会在 `person.anomaly.length` 这类访问上崩溃。
 *
 * 策略（由 tests/e2e/08-legacy-archive.test.ts 锁定，改动需同步改测试）：
 * - 兼容：缺可选字段（batch / note / anomaly / imports / perf …）→ 补默认值，记录照常加载；
 * - 拦住（整条）：记录不是对象、没有字符串 id、persons 不是数组 → 返回 null，
 *   该条存档被拒绝，不影响其它项目加载；
 * - 拦住（单行）：缺性别等无法补全的关键字段 → 保留该行但标记为无效行，
 *   不计入有效人数，原因写进 statusReason 留痕；
 * - 缺测量值（身高 / 胸围 / 腰围为 0）的行 → 保持 active，
 *   走既有的「未归并 → 守恒不通过 → 禁止导出下单表」链路拦住，由人工复核。
 */
import type { AnomalyCode, Gender, ImportRecord, ManualOverride, PatternFit, Person, PersonResult, PersonStatus, Project, ProjectKind } from './types'
import { DEFAULT_RULE_VERSION } from './sizeRules'

const GENDERS: readonly Gender[] = ['male', 'female']
const STATUSES: readonly PersonStatus[] = ['active', 'invalid', 'duplicate']
const SOURCES = ['manual', 'import'] as const
const KINDS: readonly ProjectKind[] = ['school', 'factory', 'other']
const FITS: readonly PatternFit[] = ['Y', 'A', 'B', 'C']
const ANOMALY_CODES: readonly AnomalyCode[] = [
  'height_out_of_range',
  'chest_out_of_range',
  'missing_chest',
  'missing_height',
  'missing_waist',
  'diff_out_of_range'
]

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function pickEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback
}

function normalizeOverride(raw: unknown): ManualOverride | undefined {
  const record = asRecord(raw)
  if (!record || typeof record.sizeCode !== 'string' || record.sizeCode === '') return undefined
  return {
    sizeCode: record.sizeCode,
    by: asString(record.by),
    reason: asString(record.reason),
    at: asNumber(record.at, 0)
  }
}

function normalizeResult(raw: unknown): PersonResult | null {
  const record = asRecord(raw)
  if (!record) return null
  const sizeCode = asString(record.sizeCode)
  const manualOverride = normalizeOverride(record.manualOverride)
  if (sizeCode === '' && !manualOverride) return null
  const fit =
    typeof record.fit === 'string' && (FITS as readonly string[]).includes(record.fit)
      ? (record.fit as PatternFit)
      : null
  return {
    sizeCode: sizeCode || manualOverride!.sizeCode,
    ruleSizeCode: asString(record.ruleSizeCode),
    fit,
    ruleVersion: asString(record.ruleVersion),
    ...(manualOverride ? { manualOverride } : {})
  }
}

/** 损坏占位行：persons 数组里的非对象条目，保留行位并记为无效，保证总录入行数不变 */
function placeholderPerson(index: number, projectId: string): Person {
  return {
    id: `legacy_${projectId}_${index}`,
    name: `（旧存档损坏行 #${index + 1}）`,
    gender: 'male',
    orgUnit: '',
    batch: '',
    heightCm: 0,
    weightKg: null,
    chestCm: 0,
    waistCm: 0,
    specialFlag: null,
    note: '',
    status: 'invalid',
    statusReason: '旧存档记录损坏（不是有效的量体行），已按无效行保留',
    anomaly: [],
    needsConfirm: true,
    possibleDuplicateOf: null,
    sourceRow: null,
    source: 'import',
    result: null,
    createdAt: 0
  }
}

export function normalizePerson(raw: unknown, index: number, projectId: string): Person {
  const record = asRecord(raw)
  if (!record) return placeholderPerson(index, projectId)

  const problems: string[] = []
  const id = typeof record.id === 'string' && record.id !== '' ? record.id : `legacy_${projectId}_${index}`

  let gender: Gender = 'male'
  if (typeof record.gender === 'string' && (GENDERS as readonly string[]).includes(record.gender)) {
    gender = record.gender as Gender
  } else {
    problems.push(`性别缺失或无法识别（原值：${String(record.gender ?? '空')}）`)
  }

  const anomaly: AnomalyCode[] = Array.isArray(record.anomaly)
    ? record.anomaly.filter((code): code is AnomalyCode => (ANOMALY_CODES as readonly string[]).includes(code as string))
    : []

  let status: PersonStatus = pickEnum(record.status, STATUSES, 'active')
  let statusReason = asString(record.statusReason)
  if (problems.length > 0) {
    // 关键字段无法补全：保留该行但标记无效，不计入有效人数
    if (status === 'active') status = 'invalid'
    statusReason = [`旧存档缺字段：${problems.join('；')}`, statusReason].filter((part) => part !== '').join('；')
  }

  return {
    id,
    name: asString(record.name),
    gender,
    orgUnit: asString(record.orgUnit),
    batch: asString(record.batch),
    heightCm: asNumber(record.heightCm, 0),
    weightKg: typeof record.weightKg === 'number' && Number.isFinite(record.weightKg) ? record.weightKg : null,
    chestCm: asNumber(record.chestCm, 0),
    waistCm: asNumber(record.waistCm, 0),
    specialFlag: typeof record.specialFlag === 'string' && record.specialFlag !== '' ? record.specialFlag : null,
    note: asString(record.note),
    status,
    statusReason,
    anomaly,
    needsConfirm: asBoolean(record.needsConfirm, false),
    possibleDuplicateOf: typeof record.possibleDuplicateOf === 'string' ? record.possibleDuplicateOf : null,
    sourceRow: typeof record.sourceRow === 'number' && Number.isFinite(record.sourceRow) ? record.sourceRow : null,
    source: pickEnum(record.source, SOURCES, 'import'),
    result: normalizeResult(record.result),
    createdAt: asNumber(record.createdAt, 0)
  }
}

function normalizeImportRecord(raw: unknown): ImportRecord | null {
  const record = asRecord(raw)
  if (!record || typeof record.fingerprint !== 'string') return null
  return {
    fingerprint: record.fingerprint,
    fileName: asString(record.fileName),
    at: asNumber(record.at, 0),
    rows: asNumber(record.rows, 0),
    added: asNumber(record.added, 0),
    updated: asNumber(record.updated, 0),
    invalid: asNumber(record.invalid, 0),
    skipped: asNumber(record.skipped, 0)
  }
}

/**
 * 规范化一条项目存档。返回 null 表示整条记录不兼容（被拦住），
 * 调用方应跳过该条并继续加载其余项目。
 */
export function normalizeProject(raw: unknown): Project | null {
  const record = asRecord(raw)
  if (!record) return null
  if (typeof record.id !== 'string' || record.id === '') return null
  if (!Array.isArray(record.persons)) return null

  const id = record.id
  const perf = asRecord(record.perf)
  return {
    id,
    name: asString(record.name) || '（未命名项目）',
    kind: pickEnum(record.kind, KINDS, 'other'),
    ruleVersion: asString(record.ruleVersion) || DEFAULT_RULE_VERSION,
    batches: Array.isArray(record.batches) ? record.batches.filter((item): item is string => typeof item === 'string') : [],
    persons: record.persons.map((person, index) => normalizePerson(person, index, id)),
    imports: Array.isArray(record.imports)
      ? record.imports.map(normalizeImportRecord).filter((item): item is ImportRecord => item !== null)
      : [],
    ...(perf
      ? {
          perf: {
            ...(typeof perf.mergeMs === 'number' ? { mergeMs: perf.mergeMs } : {}),
            ...(typeof perf.mergeCount === 'number' ? { mergeCount: perf.mergeCount } : {}),
            ...(typeof perf.importParseMs === 'number' ? { importParseMs: perf.importParseMs } : {}),
            ...(typeof perf.importRows === 'number' ? { importRows: perf.importRows } : {})
          }
        }
      : {}),
    createdAt: asNumber(record.createdAt, 0),
    updatedAt: asNumber(record.updatedAt, 0)
  }
}

/**
 * 旧存档兼容：IndexedDB 里可能存着早期版本写出的 Project / Person，
 * 字段集合与当前领域模型不完全一致（批次、状态、异常、来源、覆写结构等后来才加）。
 *
 * 原则：能补默认值的结构字段一律兼容，不拦住用户打开旧项目；
 * 但「量出来的数」（身高 / 胸围 / 腰围）缺失不伪造，交给分析与守恒链路处理——
 * 这类行会出现在未归并差异里，导出被守恒拦住，而不是被静默抹掉。
 */
import { BUILTIN_RULES } from './sizeRules'
import type {
  AnomalyCode,
  Gender,
  Person,
  PersonStatus,
  Project,
  SizeRule
} from './types'

const ANOMALY_CODES: AnomalyCode[] = [
  'height_out_of_range',
  'chest_out_of_range',
  'missing_chest',
  'missing_height',
  'missing_waist',
  'diff_out_of_range'
]

function asNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' && value.trim() !== '') {
    const num = Number(value)
    return Number.isFinite(num) ? num : null
  }
  return null
}

function normalizeGender(value: unknown): Gender {
  return value === 'female' ? 'female' : 'male'
}

function normalizeStatus(value: unknown): PersonStatus {
  return value === 'invalid' || value === 'duplicate' ? value : 'active'
}

function normalizeAnomaly(value: unknown): AnomalyCode[] {
  if (!Array.isArray(value)) return []
  return value.filter((code): code is AnomalyCode =>
    typeof code === 'string' && (ANOMALY_CODES as string[]).includes(code)
  )
}

/**
 * 旧版 Person 归一化。
 * malformedOverride：覆写结构损坏（缺号型 / 操作人 / 原因）时，
 * 覆写留痕被剥离，生效号型回落到按规则重算——守恒只认真实可追溯的覆写。
 */
export function normalizePerson(raw: unknown, index: number): Person {
  const record = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const result = (record.result && typeof record.result === 'object'
    ? (record.result as Record<string, unknown>)
    : null)
  const overrideRaw = result?.manualOverride
  const override =
    overrideRaw && typeof overrideRaw === 'object' ? (overrideRaw as Record<string, unknown>) : null
  const overrideOk =
    override !== null &&
    typeof override.sizeCode === 'string' &&
    override.sizeCode.trim() !== '' &&
    typeof override.by === 'string' &&
    override.by.trim() !== '' &&
    typeof override.reason === 'string' &&
    override.reason.trim() !== ''

  let normalizedResult: Person['result'] = null
  if (result) {
    const sizeCode = overrideOk ? String(override!.sizeCode) : typeof result.sizeCode === 'string' ? result.sizeCode : ''
    const ruleSizeCode = typeof result.ruleSizeCode === 'string' ? result.ruleSizeCode : sizeCode
    const fit = result.fit === 'Y' || result.fit === 'A' || result.fit === 'B' || result.fit === 'C' ? result.fit : null
    if (sizeCode) {
      normalizedResult = {
        sizeCode,
        ruleSizeCode,
        fit,
        ruleVersion: typeof result.ruleVersion === 'string' ? result.ruleVersion : '',
        ...(overrideOk
          ? {
              manualOverride: {
                sizeCode: String(override!.sizeCode),
                by: String(override!.by),
                reason: String(override!.reason),
                at: asNumber(override!.at) ?? 0
              }
            }
          : {})
      }
    }
  }

  return {
    id: typeof record.id === 'string' && record.id ? record.id : `legacy_person_${index + 1}`,
    name: typeof record.name === 'string' ? record.name : '（旧档无名氏）',
    gender: normalizeGender(record.gender),
    orgUnit: typeof record.orgUnit === 'string' ? record.orgUnit : '',
    batch: typeof record.batch === 'string' ? record.batch : '未分批',
    heightCm: asNumber(record.heightCm) ?? 0,
    weightKg: asNumber(record.weightKg),
    chestCm: asNumber(record.chestCm) ?? 0,
    waistCm: asNumber(record.waistCm) ?? 0,
    specialFlag: typeof record.specialFlag === 'string' && record.specialFlag ? record.specialFlag : null,
    note: typeof record.note === 'string' ? record.note : '',
    status: normalizeStatus(record.status),
    statusReason: typeof record.statusReason === 'string' ? record.statusReason : '',
    anomaly: normalizeAnomaly(record.anomaly),
    needsConfirm: Boolean(record.needsConfirm),
    possibleDuplicateOf: typeof record.possibleDuplicateOf === 'string' ? record.possibleDuplicateOf : null,
    sourceRow: asNumber(record.sourceRow),
    source: record.source === 'import' ? 'import' : 'manual',
    result: normalizedResult,
    createdAt: asNumber(record.createdAt) ?? 0
  }
}

/**
 * 旧版 Project 归一化。规则版本认不出来时不报错、不丢数据，
 * 按 ruleByVersion 的既定行为回落到首个内置版本（与页面运行时一致）。
 */
export function normalizeProject(raw: unknown, availableRules: SizeRule[] = BUILTIN_RULES): Project {
  const record = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const versions = new Set(availableRules.map((rule) => rule.version))
  const ruleVersion =
    typeof record.ruleVersion === 'string' && versions.has(record.ruleVersion)
      ? record.ruleVersion
      : availableRules[0]?.version ?? BUILTIN_RULES[0].version
  const personList = Array.isArray(record.persons) ? record.persons : []
  const now = Date.now()

  return {
    id: typeof record.id === 'string' && record.id ? record.id : `legacy_project_${now}`,
    name: typeof record.name === 'string' && record.name ? record.name : '（未命名旧项目）',
    kind: record.kind === 'school' || record.kind === 'factory' ? record.kind : 'other',
    ruleVersion,
    batches: Array.isArray(record.batches)
      ? record.batches.filter((item): item is string => typeof item === 'string')
      : [],
    persons: personList.map((person, index) => normalizePerson(person, index)),
    imports: Array.isArray(record.imports)
      ? record.imports
          .filter((item) => item && typeof item === 'object')
          .map((item) => {
            const entry = item as Record<string, unknown>
            return {
              fingerprint: String(entry.fingerprint ?? ''),
              fileName: String(entry.fileName ?? ''),
              at: asNumber(entry.at) ?? 0,
              rows: asNumber(entry.rows) ?? 0,
              added: asNumber(entry.added) ?? 0,
              updated: asNumber(entry.updated) ?? 0,
              invalid: asNumber(entry.invalid) ?? 0,
              skipped: asNumber(entry.skipped) ?? 0
            }
          })
          .filter((entry) => entry.fingerprint !== '')
      : [],
    perf: undefined,
    createdAt: asNumber(record.createdAt) ?? now,
    updatedAt: asNumber(record.updatedAt) ?? now
  }
}

/**
 * 确定性数据工厂：同一 seed 产生同一批量体数据，支撑「两次运行结果一致」断言。
 * 所有测量值都落在 0.5cm 网格上（与录入 / 导入解析后的存储形态一致）。
 */
import type { Gender, Person, Project, SizeRule } from '../../../src/logic/types'
import type { PersonDraft } from '../../../src/logic/analyze'
import { createPersonFromDraft } from '../../../src/logic/importPlan'

/** mulberry32：小型确定性 PRNG */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

let projectSeq = 0
export function makeProject(input: { name?: string; ruleVersion: string; batches?: string[] }): Project {
  projectSeq += 1
  return {
    id: `e2e_prj_${projectSeq}`,
    name: input.name ?? `E2E 项目 ${projectSeq}`,
    kind: 'school',
    ruleVersion: input.ruleVersion,
    batches: input.batches ?? ['春装'],
    persons: [],
    imports: [],
    createdAt: 1700000000000,
    updatedAt: 1700000000000
  }
}

export type DraftInput = {
  name: string
  gender?: Gender | null
  orgUnit?: string
  batch?: string
  heightCm?: number | null
  weightKg?: number | null
  chestCm?: number | null
  waistCm?: number | null
  specialFlag?: string | null
  note?: string
  sourceRow?: number | null
  source?: 'manual' | 'import'
}

export function makeDraft(input: DraftInput): PersonDraft {
  return {
    name: input.name,
    gender: input.gender ?? 'male',
    orgUnit: input.orgUnit ?? '高一(1)班',
    batch: input.batch ?? '春装',
    heightCm: input.heightCm ?? null,
    weightKg: input.weightKg ?? null,
    chestCm: input.chestCm ?? null,
    waistCm: input.waistCm ?? null,
    specialFlag: input.specialFlag ?? null,
    note: input.note ?? '',
    sourceRow: input.sourceRow ?? null,
    source: input.source ?? 'manual'
  }
}

/** 走与录入页 / 导入落地完全相同的构造路径（analyzeDraft 校验 + 字段组装） */
export function addPerson(project: Project, rule: SizeRule, input: DraftInput): Person {
  const person = createPersonFromDraft(makeDraft(input), rule, null)
  project.persons.push(person)
  return person
}

/** 生成一名「可归并」的人：胸腰差取自规则区间中点，胸围随身高取值，保证落在某个型别内且无异常标记 */
export function mergeableInput(
  rule: SizeRule,
  index: number,
  overrides: Partial<DraftInput> = {}
): DraftInput {
  const gender: Gender = index % 2 === 0 ? 'male' : 'female'
  const ranges = rule.fitByChestWaistDiff.find((group) => group.gender === gender)!.ranges
  const range = ranges[index % ranges.length]
  const diff = (range.minCm + range.maxCm) / 2
  const heightCm = 150 + (index % 18) * 2.5
  const chestCm = Math.round((heightCm * 0.52) / 2) * 2
  return {
    name: `生成${String(index).padStart(4, '0')}`,
    gender,
    orgUnit: `高一(${(index % 6) + 1})班`,
    batch: index % 2 === 0 ? '春装' : '秋装',
    heightCm,
    weightKg: 50 + (index % 25),
    chestCm,
    waistCm: chestCm - diff,
    sourceRow: index + 1,
    ...overrides
  }
}

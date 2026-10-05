/**
 * 带定位信息的断言：每条失败都回答「哪一步、哪个人、期望 vs 实际」。
 * stage  = 链路环节（录入与导入 / 半厘米归一 / 档位与型别 / 分档小计与守恒 / 页面小计 / 下单汇总表 / 量体明细 / 打印稿 / 导出文件 …）
 * who    = 相关的人（姓名 + 行号），汇总级断言可省略
 */
import { deepEqual, equal, match, notEqual, ok } from 'node:assert/strict'
import type { Person } from '../../../src/logic/types'

export function who(person: Pick<Person, 'name' | 'sourceRow' | 'id'>): string {
  return `${person.name}（行号 ${person.sourceRow ?? '—'}，id ${person.id}）`
}

export type Check = {
  eq(actual: unknown, expected: unknown, what: string, person?: string): void
  notEq(actual: unknown, expected: unknown, what: string, person?: string): void
  deepEq(actual: unknown, expected: unknown, what: string, person?: string): void
  ok(value: unknown, what: string, person?: string): void
  match(value: string, regExp: RegExp, what: string, person?: string): void
}

export function makeCheck(stage: string): Check {
  const prefix = (what: string, person?: string) => `[${stage}] ${what}${person ? `｜${person}` : ''}`
  return {
    eq: (actual, expected, what, person) => equal(actual, expected, prefix(what, person)),
    notEq: (actual, expected, what, person) => notEqual(actual, expected, prefix(what, person)),
    deepEq: (actual, expected, what, person) => deepEqual(actual, expected, prefix(what, person)),
    ok: (value, what, person) => ok(value, prefix(what, person)),
    match: (value, regExp, what, person) => match(value, regExp, prefix(what, person))
  }
}

/**
 * 测试运行环境的最小类型垫片：e2e 跑在 Node 20 里（scripts/run-e2e.mjs 打包后 node --test 执行），
 * 但项目不引入 @types/node 依赖，这里只声明测试实际用到的 Node 全局与内置模块。
 */

declare const performance: {
  now(): number
}

declare module 'node:test' {
  export function test(name: string, fn: () => void | Promise<void>): void
}

declare module 'node:assert/strict' {
  interface AssertStrict {
    (value: unknown, message?: string | Error): asserts value
    ok(value: unknown, message?: string | Error): asserts value
    equal(actual: unknown, expected: unknown, message?: string | Error): void
    notEqual(actual: unknown, expected: unknown, message?: string | Error): void
    deepEqual(actual: unknown, expected: unknown, message?: string | Error): void
    notDeepEqual(actual: unknown, expected: unknown, message?: string | Error): void
    match(actual: string, regexp: RegExp, message?: string | Error): void
    AssertionError: unknown
  }
  const assert: AssertStrict
  export default assert
}

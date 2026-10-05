/**
 * Node 内置模块的最小类型声明。
 * 刻意不引入 @types/node：测试链只依赖项目已有的 devDependencies（typescript），
 * 保证在没有外网、只有 node_modules 的环境里也能编译运行。
 */
declare module 'node:test' {
  export type TestFn = () => void | Promise<void>
  export function test(name: string, fn: TestFn): void
}

declare module 'node:assert/strict' {
  export function ok(value: unknown, message?: string): asserts value
  export function equal(actual: unknown, expected: unknown, message?: string): void
  export function notEqual(actual: unknown, expected: unknown, message?: string): void
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void
  export function match(value: string, regExp: RegExp, message?: string): void
  export function throws(fn: () => unknown, message?: string): void
}

/**
 * tsc 编译产物是 CommonJS，但仓库根 package.json 是 "type": "module"。
 * 在产物目录写一份 {"type":"commonjs"}，让 node --test 按 CJS 解释 .js。
 */
import { mkdirSync, writeFileSync } from 'node:fs'

const dir = new URL('./.build/', import.meta.url)
mkdirSync(dir, { recursive: true })
writeFileSync(new URL('./package.json', dir), `${JSON.stringify({ type: 'commonjs' })}\n`)
console.log('[e2e] .build/package.json 已写入 {"type":"commonjs"}')

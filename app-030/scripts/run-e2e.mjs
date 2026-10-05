/**
 * 端到端回归测试运行器（零第三方依赖，直接跑 esbuild 打包后的纯逻辑链路）。
 *
 * 用法：node scripts/run-e2e.mjs
 *  - 先把 e2e 测试入口（连同 src/logic）打包成单个 ESM，再用 node:test 执行
 *  - 全部通过：退出码 0；任一失败：打印「哪一步 / 哪个人 / 为什么」后退出码 1
 *  - 无浏览器、无外部服务、无网络，可直接挂到 CI / 门禁
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const require = createRequire(import.meta.url)
// esbuild 的 bin 是平台原生 ELF/可执行文件，取其真实路径直接执行（不走 node 解释）
const esbuildBin = require.resolve('esbuild/bin/esbuild')

const dir = mkdtempSync(join(tmpdir(), 'app030-e2e-'))
const bundle = join(dir, 'e2e.bundle.mjs')

try {
  const bundled = spawnSync(
    esbuildBin,
    [join(root, 'e2e/index.test.ts'), '--bundle', '--platform=node', '--format=esm', `--outfile=${bundle}`],
    { cwd: root, encoding: 'utf8' }
  )
  if (bundled.status !== 0) {
    process.stderr.write(bundled.stderr || 'esbuild 打包失败\n')
    process.exit(1)
  }

  const run = spawnSync(
    process.execPath,
    [
      '--test',
      '--test-reporter=spec',
      // 各用例自带耗时断言；大批量用例单独放宽
      '--test-timeout=30000',
      bundle
    ],
    { cwd: root, stdio: 'inherit' }
  )
  process.exit(run.status ?? 1)
} finally {
  rmSync(dir, { recursive: true, force: true })
}

/**
 * e2e 入口：import 顺序即执行顺序（node:test 也按文件内注册顺序跑）。
 * 各用例文件自带「钉住的是整条链而非单个函数」的场景，失败时断言信息点到步骤与人。
 */
import './01-full-chain.test'
import './02-precision-and-rules.test'
import './03-overrides.test'
import './04-consistency-and-gate.test'
import './05-cells-and-csv.test'
import './06-legacy-archive.test'
import './07-bulk-determinism.test'

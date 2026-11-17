/**
 * 跨模块调用链集成验证：
 * timewindow 页面 runAction → local-service.runAction('timewindow', ...)
 *   → notifyTimewindowConfigChange → anomaly-period-service.applyConfigChange
 * 核对：只重算受影响异常时段清单，其余时段沿用原版本，时段异常联动入口复用同一份数据。
 * 运行：node --import ./register.mjs linkage.test.ts
 */
const store = new Map<string, string>()
;(globalThis as any).window = {
  localStorage: {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => {
      store.set(k, v)
    },
    removeItem: (k: string) => {
      store.delete(k)
    },
  },
}

const { runAction, listEntries } = await import('@/api/local-service.ts')
const { listVerdicts, resetAnomalyPeriods, submitDetection } = await import(
  '@/api/anomaly-period-service.ts'
)

let passed = 0
let failed = 0
function assert(cond: boolean, label: string): void {
  if (cond) {
    passed += 1
    console.log(`  PASS  ${label}`)
  } else {
    failed += 1
    console.error(`  FAIL  ${label}`)
  }
}

resetAnomalyPeriods()

console.log('\n[联动] 先造一个不在 TIME-0003 配置下的时段，用于验证范围隔离')
{
  submitDetection({
    requestId: 'REQ-LINK-OTHER',
    detectorId: 'ANOM-0007',
    configId: 'TIME-0001',
    periodName: '早高峰时段',
    windowStartMin: 420,
    windowEndMin: 540,
    monitorEvent: '启动事件',
    pattern: '突降',
    peakDeviation: 0.11,
    support: 260,
    falseAlarmRate: 0.04,
    version: 1,
    abnormal: false,
  })
}

console.log('\n[联动] 调用链核对：时段配置状态流转触发异常检测联动重算')
{
  const before = listVerdicts()
  const target3 = before.find((v) => v.configId === 'TIME-0003')!
  const target1 = before.find((v) => v.configId === 'TIME-0001')!
  const v3Before = target3.version
  const v1Snapshot = JSON.stringify(target1)

  // 与 timewindow 页面同一入口：local-service.runAction
  // 播种里 TIME-0003 当前是「已启用」，用「停用配置」制造一次真实状态流转。
  const result = runAction('timewindow', 3, '停用配置')

  assert(result.ok === true, '时段配置流转成功')
  assert(result.message.includes('联动'), `返回信息包含联动说明：${result.message}`)

  const after = listVerdicts()
  const t3 = after.find((v) => v.configId === 'TIME-0003')!
  const t1 = after.find((v) => v.configId === 'TIME-0001')!
  assert(t3.version === v3Before + 1, '受影响异常时段清单版本抬升一档')
  assert(t3.sources.length === target3.sources.length, '重算只改结论，检测来源全部保留')
  assert(JSON.stringify(t1) === v1Snapshot, '其余时段配置（TIME-0001）沿用原版本，未被重算')
  assert(after.length === before.length, '清单条目数量不变，没有重复生成异常时段')

  // 时段分析自身的清单状态也确实流转了
  const rows = listEntries('timewindow').items
  assert(String(rows.find((r) => Number(r.id) === 3)?.status) === '已停用', '时段配置状态已更新为已停用')
}

console.log('\n[联动] 未挂异常清单的配置流转：不产生联动写入但动作本身成功')
{
  // TIME-0002（id=2）下没有任何异常时段结论
  const result = runAction('timewindow', 2, '启用配置')
  assert(result.ok === true, '动作成功')
  assert(result.message.includes('暂无异常时段清单'), `无联动时给出说明：${result.message}`)
}

console.log(`\n结果：通过 ${passed} 项，失败 ${failed} 项`)
if (failed > 0) {
  process.exitCode = 1
}

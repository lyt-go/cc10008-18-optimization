/**
 * 服务层验证：localStorage 垫片 + '@/' 别名，验证真实服务入口的行为。
 * 运行：node --import ./register.mjs anomaly-service.test.ts
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

const {
  submitDetection,
  listVerdicts,
  recomputeAffected,
  applyConfigChange,
  switchStrategy,
  resetAnomalyPeriods,
} = await import('@/api/anomaly-period-service.ts')

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

// 播种数据里 TIME-0003::晚高峰时段 已有 4 条来源、1 条结论
resetAnomalyPeriods()

console.log('\n[服务] 播种状态：两个检测器覆盖同一时段只保留一条结论')
{
  const verdicts = listVerdicts()
  assert(verdicts.length === 1, '初始只有一条时段归并结论')
  const seed = verdicts[0]
  assert(new Set(seed.sources.map((s) => s.detectorId)).size >= 2, '该结论可展开到多个检测器来源')
  assert(seed.sources.length === 4, '全部 4 条检测来源保留可回查')
  assert(seed.abnormal === true, '当前异常只出现一次')
}

console.log('\n[服务 B] 重复提交请求只写入一次，另一请求被拒绝')
{
  const payload = {
    detectorId: 'ANOM-0001',
    configId: 'TIME-0003',
    periodName: '晚高峰时段',
    windowStartMin: 1080,
    windowEndMin: 1200,
    monitorEvent: '点击事件',
    pattern: '突增',
    peakDeviation: 0.3,
    support: 1000,
    falseAlarmRate: 0.06,
    version: 5,
    abnormal: true,
  }
  const r1 = submitDetection({ requestId: 'REQ-DUP-X', ...payload })
  const before = listVerdicts()[0].sources.length
  const r2 = submitDetection({ requestId: 'REQ-DUP-X', ...payload })
  const after = listVerdicts()[0].sources.length

  assert(r1.ok === true, '首次提交成功')
  assert(r2.ok === false && r2.message.includes('重复提交已拒绝'), '重复提交被拒绝并给出原因')
  assert(before === after, '拒绝后来源数量不变，未重复增加告警')
}

console.log('\n[服务 A] 后到检测复用已收录来源（迟到支持量更新）')
{
  const before = listVerdicts()[0].sources.length
  const r = submitDetection({
    requestId: 'REQ-LATE-1',
    detectorId: 'ANOM-0001',
    configId: 'TIME-0003',
    periodName: '晚高峰时段',
    windowStartMin: 1080,
    windowEndMin: 1200,
    monitorEvent: '点击事件',
    pattern: '突增',
    peakDeviation: 0.5,
    support: 2200,
    falseAlarmRate: 0.06,
    version: 6,
    abnormal: true,
  })
  const after = listVerdicts()[0]
  assert(r.ok === true && r.reusedSourceId === 'SRC-0001', '复用了已收录来源 SRC-0001')
  assert(after.sources.length === before, '来源数量不增加')
  const reused = after.sources.find((s) => s.sourceId === 'SRC-0001')!
  assert(reused.support === 2200 && reused.version === 6, '迟到支持量与版本合并进原来源')
}

console.log('\n[服务 C] 受影响范围重算：目标时段重算、来源保留，范围外不动')
{
  // 先造第二个时段，验证范围隔离
  submitDetection({
    requestId: 'REQ-OTHER-1',
    detectorId: 'ANOM-0005',
    configId: 'TIME-0003',
    periodName: '午间时段',
    windowStartMin: 720,
    windowEndMin: 840,
    monitorEvent: '曝光事件',
    pattern: '突降',
    peakDeviation: 0.12,
    support: 300,
    falseAlarmRate: 0.09,
    version: 1,
    abnormal: false,
  })
  const allBefore = listVerdicts()
  const noonBefore = JSON.stringify(allBefore.find((v) => v.periodName === '午间时段'))
  const r = recomputeAffected([{ configId: 'TIME-0003', periodName: '晚高峰时段' }])
  assert(r.ok === true && r.message.includes('受影响范围重算'), '受影响范围重算成功')
  const allAfter = listVerdicts()
  const night = allAfter.find((v) => v.periodName === '晚高峰时段')!
  assert(night.sources.length === 4, '重算后检测来源全部保留')
  assert(typeof night.falseAlarmRate === 'number', '误报率数据随受影响范围重算')
  const noonAfter = JSON.stringify(allAfter.find((v) => v.periodName === '午间时段'))
  assert(noonBefore === noonAfter, '范围外时段沿用原版本')
  const invalid = recomputeAffected([{ configId: 'TIME-9999', periodName: '不存在时段' }])
  assert(invalid.ok === false, '无对应结论的范围被拒绝且不误写')
}

console.log('\n[服务 D] 跨模块更新（时段配置变更）只改受影响异常时段清单')
{
  const before = listVerdicts().map((v) => ({ key: v.periodKey, version: v.version, mergedAt: v.mergedAt }))
  const r = applyConfigChange({ configId: 'TIME-0003', affectedPeriods: ['晚高峰时段'], version: 9 })
  assert(r.ok === true && r.affected.length === 1, '联动只返回受影响时段')
  const after = listVerdicts()
  const night = after.find((v) => v.periodName === '晚高峰时段')!
  const noon = after.find((v) => v.periodName === '午间时段')!
  assert(night.version >= 9, '受影响时段版本抬升到配置新版本')
  const noonBeforeRow = before.find((b) => b.key === noon.periodKey)!
  assert(noon.version === noonBeforeRow.version && noon.mergedAt === noonBeforeRow.mergedAt, '其余时段配置沿用原版本')
  const miss = applyConfigChange({ configId: 'TIME-8888', affectedPeriods: ['未知'], version: 1 })
  assert(miss.ok === false, '未命中清单的配置变更不产生写入')
}

console.log('\n[服务 E] 两种仲裁切换：事件归并 / 窗口归并，异常只一次、来源可展开')
{
  const r1 = switchStrategy('window')
  assert(r1.ok === true, '切换到检测窗口归并')
  const v1 = listVerdicts().find((v) => v.periodName === '晚高峰时段')!
  assert(v1.strategy === 'window', '结论记录当前仲裁策略为 window')
  assert(v1.windowGroups.length >= 1 && v1.eventGroups.length >= 1, '两种对照表都保留可展开')
  assert(v1.abnormal === true && v1.sources.length === 4, '窗口归并下当前异常仍只一次、来源不丢')
  const again = switchStrategy('window')
  assert(again.ok === false, '重复切换同策略被拒绝')
  const r2 = switchStrategy('event')
  const v2 = listVerdicts().find((v) => v.periodName === '晚高峰时段')!
  assert(r2.ok === true && v2.strategy === 'event', '切回监控事件归并')
  assert(v2.eventGroups.some((g) => g.monitorEvent === '点击事件' && g.detectorIds.includes('ANOM-0002')), '按事件合并的告警来源清单可展开到检测器')
  assert(listVerdicts().length === 2, '仲裁切换不改变结论数量')
}

console.log(`\n结果：通过 ${passed} 项，失败 ${failed} 项`)
if (failed > 0) {
  process.exitCode = 1
}

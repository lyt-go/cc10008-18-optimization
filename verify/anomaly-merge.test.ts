/**
 * 异常时段归并引擎验证（node 直接运行 TS，type stripping）。
 * 覆盖任务全部验收点：
 * A. 两个重叠窗口同时汇总只生成一次归并结果，后到检测复用来源、不重复增加告警
 * B. 重复提交只写一次，另一请求被拒绝
 * C. 受影响范围重算：误报率只随受影响范围重算，检测来源保留
 * D. 跨模块更新只改受影响异常时段清单，其余时段沿用原版本
 * E. 版本冲突两种仲裁：按事件合并的告警来源清单 / 按窗口合并的峰值偏差对照表，
 *    无论哪条，当前异常只出现一次且来源可展开回查
 * F. 两个检测器覆盖同一时段，清单只保留一条当前结论并能展开全部来源
 */
import {
  buildVerdict,
  mergeByEvent,
  mergeByWindow,
  mergeSource,
  periodKeyOf,
  reArbitrate,
  recomputeScoped,
} from '../frontend/src/data/anomaly-period/engine.ts'
import type {
  AnomalyPeriodVerdict,
  AnomalySource,
  SubmitSourceInput,
} from '../frontend/src/data/anomaly-period/types.ts'

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

const NOW = '2026-11-17T10:00:00.000Z'
let seq = 1
function input(partial: Partial<SubmitSourceInput> & Pick<SubmitSourceInput, 'requestId' | 'detectorId' | 'configId' | 'periodName'>): SubmitSourceInput {
  return {
    windowStartMin: 1080,
    windowEndMin: 1200,
    monitorEvent: '点击事件',
    pattern: '突增',
    peakDeviation: 0.3,
    support: 1000,
    falseAlarmRate: 0.06,
    version: 1,
    abnormal: true,
    ...partial,
  }
}

// ------------------------------------------------------------------
console.log('\n[场景 A/F] 两个检测器覆盖同一时段、窗口重叠：只保留一条结论，来源可展开')
{
  let verdicts: Record<string, AnomalyPeriodVerdict> = {}
  const r1 = mergeSource(verdicts, input({
    requestId: 'REQ-1', detectorId: 'ANOM-0001', configId: 'TIME-0003', periodName: '晚高峰时段',
    windowStartMin: 1080, windowEndMin: 1200, peakDeviation: 0.32, falseAlarmRate: 0.06,
  }), 'event', seq, NOW)
  verdicts = r1.verdicts; seq = r1.seq
  const r2 = mergeSource(verdicts, input({
    requestId: 'REQ-2', detectorId: 'ANOM-0002', configId: 'TIME-0003', periodName: '晚高峰时段',
    windowStartMin: 1140, windowEndMin: 1260, peakDeviation: 0.41, falseAlarmRate: 0.08, version: 2,
  }), 'event', seq, NOW)
  verdicts = r2.verdicts; seq = r2.seq

  const key = periodKeyOf('TIME-0003', '晚高峰时段')
  assert(Object.keys(verdicts).length === 1, '同一时段只生成一条归并结论')
  assert(verdicts[key].sources.length === 2, '两条检测来源都被收录、可展开回查')
  assert(verdicts[key].abnormal === true, '当前异常只出现一次（结论级 abnormal 为单一布尔）')
  assert(verdicts[key].eventGroups.length === 1, '同一监控事件归并成一行告警来源清单')
  assert(verdicts[key].eventGroups[0].detectorIds.join() === 'ANOM-0001,ANOM-0002', '事件行可展开到两个检测器来源')
  assert(verdicts[key].eventGroups[0].sourceIds.length === 2, '事件行保留全部 sourceId 供回查')
  assert(verdicts[key].windowGroups.length === 2, '两个不同窗口区间各一行峰值偏差对照')
}

// ------------------------------------------------------------------
console.log('\n[场景 A] 两个重叠窗口同时汇总（同检测器同窗口同事件）：后到复用来源，不重复增加告警')
{
  let verdicts: Record<string, AnomalyPeriodVerdict> = {}
  const base = input({ requestId: 'REQ-3', detectorId: 'ANOM-0001', configId: 'TIME-0003', periodName: '晚高峰时段' })
  const r1 = mergeSource(verdicts, base, 'event', seq, NOW)
  verdicts = r1.verdicts; seq = r1.seq
  // 迟到支持量更新：同检测器/同时段/同窗口/同事件，仅版本与支持量更新
  const late = input({ requestId: 'REQ-4', detectorId: 'ANOM-0001', configId: 'TIME-0003', periodName: '晚高峰时段', support: 1500, version: 3, peakDeviation: 0.35 })
  const r2 = mergeSource(verdicts, late, 'event', seq, NOW)
  verdicts = r2.verdicts; seq = r2.seq
  const key = periodKeyOf('TIME-0003', '晚高峰时段')

  assert(r2.ok === true, '迟到更新被接受')
  assert(r2.reusedSourceId === r1.verdict?.sources[0].sourceId, '后到检测复用已收录来源 ID')
  assert(verdicts[key].sources.length === 1, '复用来源后来源数量不增加（不产生重复告警）')
  assert(verdicts[key].sources[0].support === 1500, '迟到支持量已合并进原来源')
  assert(verdicts[key].sources[0].version === 3, '版本冲突取高版本')
  assert(verdicts[key].sources[0].falseAlarmRate === 0.06, '来源保留自身检测出处的误报率')
}

// ------------------------------------------------------------------
console.log('\n[场景 B] 重复提交请求：只写入一次，另一请求被拒绝')
{
  let verdicts: Record<string, AnomalyPeriodVerdict> = {}
  const r1 = mergeSource(verdicts, input({ requestId: 'DUP-1', detectorId: 'ANOM-0009', configId: 'TIME-0009', periodName: '夜间时段' }), 'event', seq, NOW)
  verdicts = r1.verdicts; seq = r1.seq
  const before = JSON.stringify(verdicts)
  const r2 = mergeSource(verdicts, input({ requestId: 'DUP-1', detectorId: 'ANOM-0009', configId: 'TIME-0009', periodName: '夜间时段' }), 'event', seq, NOW)

  assert(r1.ok === true, '首次提交写入成功')
  assert(r2.ok === false, '相同 requestId 的重复提交被拒绝')
  assert(JSON.stringify(verdicts) === before, '被拒绝请求未产生任何写入')
  assert(r2.reusedSourceId !== undefined, '拒绝时回指已收录来源以便回查')
}

// ------------------------------------------------------------------
console.log('\n[场景 C] 受影响范围重算：只动目标时段，误报率按范围内来源重算且来源保留')
{
  const sourcesA: AnomalySource[] = [
    { sourceId: 'SRC-A1', requestId: 'RA1', detectorId: 'D1', configId: 'CFG-1', periodName: 'P1', windowStartMin: 0, windowEndMin: 60, monitorEvent: 'e1', pattern: '突增', peakDeviation: 0.2, support: 100, falseAlarmRate: 0.1, version: 1, abnormal: true, seq: 1 },
    { sourceId: 'SRC-A2', requestId: 'RA2', detectorId: 'D2', configId: 'CFG-1', periodName: 'P1', windowStartMin: 30, windowEndMin: 90, monitorEvent: 'e1', pattern: '突增', peakDeviation: 0.4, support: 200, falseAlarmRate: 0.2, version: 1, abnormal: true, seq: 2 },
  ]
  const sourcesB: AnomalySource[] = [
    { sourceId: 'SRC-B1', requestId: 'RB1', detectorId: 'D3', configId: 'CFG-1', periodName: 'P2', windowStartMin: 0, windowEndMin: 60, monitorEvent: 'e2', pattern: '漂移', peakDeviation: 0.1, support: 90, falseAlarmRate: 0.5, version: 1, abnormal: false, seq: 3 },
  ]
  let verdicts: Record<string, AnomalyPeriodVerdict> = {
    [periodKeyOf('CFG-1', 'P1')]: buildVerdict('CFG-1', 'P1', sourcesA, 'event', NOW),
    [periodKeyOf('CFG-1', 'P2')]: buildVerdict('CFG-1', 'P2', sourcesB, 'event', NOW),
  }
  const untouchedSnapshot = JSON.stringify(verdicts[periodKeyOf('CFG-1', 'P2')])
  // P1 来源误报率发生调整（受影响范围重算）
  const adjustedA = sourcesA.map((s) => ({ ...s, falseAlarmRate: s.sourceId === 'SRC-A1' ? 0.16 : 0.24 }))
  verdicts[periodKeyOf('CFG-1', 'P1')] = buildVerdict('CFG-1', 'P1', adjustedA, 'event', '2026-11-17T11:00:00.000Z', verdicts[periodKeyOf('CFG-1', 'P1')])
  const next = recomputeScoped(verdicts, [{ configId: 'CFG-1', periodName: 'P1' }], 'event', '2026-11-17T12:00:00.000Z')

  assert(next[periodKeyOf('CFG-1', 'P1')].sources.length === 2, '重算后检测来源全部保留')
  assert(next[periodKeyOf('CFG-1', 'P1')].falseAlarmRate === 0.2, '误报率只按受影响时段的异常来源均值重算 ((0.16+0.24)/2)')
  assert(JSON.stringify(next[periodKeyOf('CFG-1', 'P2')]) === untouchedSnapshot, '范围外时段 P2 完全沿用原版本')
}

// ------------------------------------------------------------------
console.log('\n[场景 D] 跨模块更新落在异常检测：只改受影响清单，其余时段配置沿用原版本')
{
  const v1 = buildVerdict('CFG-X', 'P1', [{ sourceId: 'S1', requestId: 'Q1', detectorId: 'D1', configId: 'CFG-X', periodName: 'P1', windowStartMin: 0, windowEndMin: 60, monitorEvent: 'e', pattern: '突增', peakDeviation: 0.2, support: 100, falseAlarmRate: 0.1, version: 1, abnormal: true, seq: 1 }], 'event', NOW)
  const v2 = buildVerdict('CFG-X', 'P2', [{ sourceId: 'S2', requestId: 'Q2', detectorId: 'D2', configId: 'CFG-X', periodName: 'P2', windowStartMin: 0, windowEndMin: 60, monitorEvent: 'e', pattern: '突增', peakDeviation: 0.3, support: 100, falseAlarmRate: 0.1, version: 1, abnormal: true, seq: 2 }], 'event', NOW)
  const verdicts: Record<string, AnomalyPeriodVerdict> = { [v1.periodKey]: v1, [v2.periodKey]: v2 }
  const p2Before = JSON.stringify(verdicts[periodKeyOf('CFG-X', 'P2')])
  const next = recomputeScoped(verdicts, [{ configId: 'CFG-X', periodName: 'P1' }], 'event', '2026-11-17T12:00:00.000Z')

  assert(next[periodKeyOf('CFG-X', 'P1')].mergedAt === '2026-11-17T12:00:00.000Z', '受影响时段 P1 被重算')
  assert(JSON.stringify(next[periodKeyOf('CFG-X', 'P2')]) === p2Before, '未受影响时段 P2 沿用原版本未被触碰')
  assert(Object.keys(next).length === 2, '清单条目数量不变，没有新增重复异常时段')
}

// ------------------------------------------------------------------
console.log('\n[场景 E] 版本冲突两种仲裁：事件归并 vs 窗口归并，异常只一次、来源都可展开')
{
  const sources: AnomalySource[] = [
    { sourceId: 'S1', requestId: 'Q1', detectorId: 'D1', configId: 'CFG', periodName: 'P', windowStartMin: 0, windowEndMin: 60, monitorEvent: '点击', pattern: '突增', peakDeviation: 0.5, support: 100, falseAlarmRate: 0.1, version: 3, abnormal: true, seq: 1 },
    { sourceId: 'S2', requestId: 'Q2', detectorId: 'D2', configId: 'CFG', periodName: 'P', windowStartMin: 0, windowEndMin: 60, monitorEvent: '支付', pattern: '漂移', peakDeviation: 0.2, support: 80, falseAlarmRate: 0.1, version: 2, abnormal: true, seq: 2 },
    { sourceId: 'S3', requestId: 'Q3', detectorId: 'D1', configId: 'CFG', periodName: 'P', windowStartMin: 30, windowEndMin: 90, monitorEvent: '点击', pattern: '突增', peakDeviation: 0.7, support: 120, falseAlarmRate: 0.1, version: 4, abnormal: true, seq: 3 },
  ]
  const eventVerdict = buildVerdict('CFG', 'P', sources, 'event', NOW)
  assert(eventVerdict.abnormal === true, '事件仲裁下当前异常只出现一次')
  const eventGroups = mergeByEvent(sources)
  assert(eventGroups.length === 2, '按事件合并：点击/支付各一行告警来源清单')
  const click = eventGroups.find((g) => g.monitorEvent === '点击')!
  assert(click.sourceIds.join() === 'S1,S3', '点击事件行展开两个窗口的来源回查')
  assert(click.version === 4 && click.peakDeviation === 0.7, '事件行取最高版本与峰值偏差')

  const windowGroups = mergeByWindow(sources)
  assert(windowGroups.length === 2, '按窗口合并：两个窗口区间各一行峰值偏差对照表')
  const w1 = windowGroups.find((g) => g.windowStartMin === 0)!
  assert(w1.peakDeviation === 0.5 && w1.sourceIds.join() === 'S1,S2', '窗口行取区间峰值并保留全部来源')
  const w2 = windowGroups.find((g) => g.windowStartMin === 30)!
  assert(w2.peakDeviation === 0.7 && w2.sourceIds.join() === 'S3', '第二窗口峰值对照正确')

  const re = reArbitrate({ [eventVerdict.periodKey]: eventVerdict }, 'window', NOW)
  const switched = re[eventVerdict.periodKey]
  assert(switched.strategy === 'window', '可切换到检测窗口归并')
  assert(switched.sources.length === 3, '切换仲裁不丢来源、可展开回查')
  assert(switched.abnormal === true && Object.keys(re).length === 1, '切换后当前异常仍只出现一次、结论仍只一条')
  assert(switched.eventGroups.length === 2 && switched.windowGroups.length === 2, '两种对照表都可随时展开')
}

// ------------------------------------------------------------------
console.log('\n[附加] 噪声不累积：同一时段混合重复提交/迟到更新后，结论始终一条')
{
  let verdicts: Record<string, AnomalyPeriodVerdict> = {}
  let s = seq
  const cfg = { configId: 'TIME-1', periodName: '午间时段' }
  const stream: SubmitSourceInput[] = [
    input({ requestId: 'M-1', detectorId: 'D1', ...cfg, monitorEvent: 'e', version: 1 }),
    input({ requestId: 'M-2', detectorId: 'D2', ...cfg, monitorEvent: 'e', version: 1, windowStartMin: 30, windowEndMin: 90 }),
    input({ requestId: 'M-1', detectorId: 'D1', ...cfg, monitorEvent: 'e', version: 1 }), // 重复请求
    input({ requestId: 'M-3', detectorId: 'D1', ...cfg, monitorEvent: 'e', version: 2, support: 2000 }), // 迟到更新
    input({ requestId: 'M-2', detectorId: 'D2', ...cfg, monitorEvent: 'e', version: 1, windowStartMin: 30, windowEndMin: 90 }), // 重复请求
  ]
  const results: boolean[] = []
  for (const item of stream) {
    const r = mergeSource(verdicts, item, 'event', s, NOW)
    verdicts = r.verdicts; s = r.seq
    results.push(r.ok)
  }
  const key = periodKeyOf(cfg.configId, cfg.periodName)
  assert(results.join(',') === 'true,true,false,true,false', '提交结果序列：成功/成功/拒绝/成功/拒绝')
  assert(Object.keys(verdicts).length === 1, '噪声过后仍只有一条时段结论')
  assert(verdicts[key].sources.length === 2, '只保留两个检测器各一份来源，无重复告警')
}

console.log(`\n结果：通过 ${passed} 项，失败 ${failed} 项`)
if (failed > 0) {
  process.exitCode = 1
}

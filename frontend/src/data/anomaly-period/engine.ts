/**
 * 异常时段归并纯引擎：不读 localStorage、不依赖 Vue，可在 Node 下独立验证。
 *
 * 关键不变量：
 * 1. 同一时段（periodKey = configId + periodName）只生成一条归并结论；
 * 2. 两个重叠窗口同时汇总时，同一检测器的重复判定只收录一次，后到检测复用已收录来源，
 *    不重复增加当前告警；
 * 3. 来源（检测出处）始终保留，结论可展开回查到每一条来源；
 * 4. 受影响范围重算只动目标时段，其它时段的结论版本与来源保持原样；
 * 5. 版本冲突提供两种仲裁：event（按事件合并的告警来源清单）/ window（按窗口合并的峰值偏差对照表），
 *    无论哪种，当前异常只出现一次且来源可展开。
 */
import type {
  AnomalyPeriodVerdict,
  AnomalySource,
  EventMergedRow,
  MergeStrategy,
  SubmitResult,
  SubmitSourceInput,
  WindowMergedRow,
} from './types'

export function periodKeyOf(configId: string, periodName: string): string {
  return `${configId}::${periodName}`
}

/** 来源去重指纹：同一检测器对同一时段、同一窗口区间、同一监控事件的判定视为同一份来源。 */
function sourceFingerprint(input: Pick<
  SubmitSourceInput,
  'detectorId' | 'configId' | 'periodName' | 'windowStartMin' | 'windowEndMin' | 'monitorEvent'
>): string {
  return [
    input.detectorId,
    input.configId,
    input.periodName,
    input.windowStartMin,
    input.windowEndMin,
    input.monitorEvent,
  ].join('|')
}

/**
 * 按事件合并的告警来源清单：以监控事件为键聚合来源。
 * 同一事件的多个检测器来源合并成一行，来源全部展开保留。
 */
export function mergeByEvent(sources: AnomalySource[]): EventMergedRow[] {
  const groups = new Map<string, EventMergedRow>()
  for (const source of [...sources].sort((a, b) => a.seq - b.seq)) {
    const key = source.monitorEvent
    const existing = groups.get(key)
    if (!existing) {
      groups.set(key, {
        monitorEvent: source.monitorEvent,
        sourceIds: [source.sourceId],
        detectorIds: [source.detectorId],
        pattern: source.pattern,
        version: source.version,
        peakDeviation: source.peakDeviation,
      })
      continue
    }
    existing.sourceIds.push(source.sourceId)
    if (!existing.detectorIds.includes(source.detectorId)) {
      existing.detectorIds.push(source.detectorId)
    }
    existing.version = Math.max(existing.version, source.version)
    existing.peakDeviation = Math.max(existing.peakDeviation, source.peakDeviation)
  }
  return [...groups.values()].sort((a, b) => b.peakDeviation - a.peakDeviation)
}

/**
 * 按窗口合并的峰值偏差对照表：以重叠窗口区间为键，取峰值偏差最大的来源做对照。
 * 窗口区间相同即视为同一汇总点（两个重叠窗口同时汇总只生成一行）。
 */
export function mergeByWindow(sources: AnomalySource[]): WindowMergedRow[] {
  const groups = new Map<string, WindowMergedRow>()
  for (const source of [...sources].sort((a, b) => a.seq - b.seq)) {
    const key = `${source.windowStartMin}-${source.windowEndMin}`
    const existing = groups.get(key)
    if (!existing) {
      groups.set(key, {
        windowStartMin: source.windowStartMin,
        windowEndMin: source.windowEndMin,
        sourceIds: [source.sourceId],
        detectorIds: [source.detectorId],
        peakDeviation: source.peakDeviation,
        monitorEvent: source.monitorEvent,
        version: source.version,
      })
      continue
  }
    existing.sourceIds.push(source.sourceId)
    if (!existing.detectorIds.includes(source.detectorId)) {
      existing.detectorIds.push(source.detectorId)
    }
    existing.version = Math.max(existing.version, source.version)
    // 峰值偏差对照：保留最大偏差，其它来源仍可在 sourceIds 展开回查。
    if (source.peakDeviation > existing.peakDeviation) {
      existing.peakDeviation = source.peakDeviation
      existing.monitorEvent = source.monitorEvent
    }
  }
  return [...groups.values()].sort((a, b) => a.windowStartMin - b.windowStartMin)
}

/** 由来源清单重算单条时段结论。误报率只在受影响时段内按来源汇总，不被其它时段摊薄。 */
export function buildVerdict(
  configId: string,
  periodName: string,
  sources: AnomalySource[],
  strategy: MergeStrategy,
  now: string,
  previous?: AnomalyPeriodVerdict,
): AnomalyPeriodVerdict {
  const ordered = [...sources].sort((a, b) => a.seq - b.seq)
  const abnormalSources = ordered.filter((source) => source.abnormal)
  const scope = abnormalSources.length > 0 ? abnormalSources : ordered
  // 受影响范围重算：误报率按该时段内有效来源取均值，保留每条来源自身的检测出处。
  const falseAlarmRate =
    scope.length === 0
      ? previous?.falseAlarmRate ?? 0
      : scope.reduce((sum, source) => sum + source.falseAlarmRate, 0) / scope.length
  return {
    periodKey: periodKeyOf(configId, periodName),
    configId,
    periodName,
    sources: ordered,
    abnormal: abnormalSources.length > 0,
    falseAlarmRate: Number(falseAlarmRate.toFixed(4)),
    version: ordered.reduce((max, source) => Math.max(max, source.version), previous?.version ?? 0),
    mergedAt: now,
    strategy,
    eventGroups: mergeByEvent(ordered),
    windowGroups: mergeByWindow(ordered),
  }
}

/** 在已有结论里定位等价来源（同检测器/同时段/同窗口/同事件）。 */
export function findEquivalentSource(
  sources: AnomalySource[],
  input: SubmitSourceInput,
): AnomalySource | undefined {
  const fingerprint = sourceFingerprint(input)
  return sources.find((source) =>
    sourceFingerprint({
      detectorId: source.detectorId,
      configId: source.configId,
      periodName: source.periodName,
      windowStartMin: source.windowStartMin,
      windowEndMin: source.windowEndMin,
      monitorEvent: source.monitorEvent,
    }) === fingerprint,
  )
}

/**
 * 把一次检测判定归并进结论表（纯函数，返回新表）。
 * - requestId 相同视为重复提交：只写一次，后一个请求被拒绝；
 * - 等价来源已收录时复用来源，不重复增加当前告警（迟到支持量更新走版本仲裁）。
 */
export function mergeSource(
  verdicts: Record<string, AnomalyPeriodVerdict>,
  input: SubmitSourceInput,
  strategy: MergeStrategy,
  nextSeq: number,
  now: string,
): SubmitResult & { verdicts: Record<string, AnomalyPeriodVerdict>; seq: number } {
  const key = periodKeyOf(input.configId, input.periodName)
  const previous = verdicts[key]

  // 1) 幂等：同一 requestId 重复提交，直接拒绝且不写入。
  if (previous && previous.sources.some((source) => source.requestId === input.requestId)) {
    const reused = previous.sources.find((source) => source.requestId === input.requestId)
    return {
      ok: false,
      message: `重复提交已拒绝：请求 ${input.requestId} 的异常时段判定清单只写入一次`,
      reusedSourceId: reused?.sourceId,
      verdict: previous,
      verdicts,
      seq: nextSeq,
    }
  }

  // 2) 等价来源去重：两个重叠窗口同时汇总时，后到检测复用已收录来源。
  if (previous) {
    const equivalent = findEquivalentSource(previous.sources, input)
    if (equivalent) {
      // 迟到支持量更新落在同一时段：按当前仲裁策略保留高版本，来源合并而非新增告警。
      const mergedSource: AnomalySource = {
        ...equivalent,
        support: Math.max(equivalent.support, input.support),
        peakDeviation: Math.max(equivalent.peakDeviation, input.peakDeviation),
        falseAlarmRate: input.falseAlarmRate,
        version: Math.max(equivalent.version, input.version),
        // 任一次判定异常，该来源即维持异常，但不会产生第二条结论。
        abnormal: equivalent.abnormal || input.abnormal,
      }
      const sources = previous.sources.map((source) =>
        source.sourceId === equivalent.sourceId ? mergedSource : source,
      )
      const verdict = buildVerdict(input.configId, input.periodName, sources, strategy, now, previous)
      return {
        ok: true,
        message: `已复用来源 ${equivalent.sourceId}，迟到支持量更新按${
          strategy === 'event' ? '监控事件' : '检测窗口'
        }归并，未重复增加当前告警`,
        reusedSourceId: equivalent.sourceId,
        verdict,
        verdicts: { ...verdicts, [key]: verdict },
        seq: nextSeq,
      }
    }
  }

  // 3) 新来源：同一时段仍只有一条结论，来源挂到该结论下。
  const source: AnomalySource = {
    sourceId: `SRC-${String(nextSeq).padStart(4, '0')}`,
    requestId: input.requestId,
    detectorId: input.detectorId,
    configId: input.configId,
    periodName: input.periodName,
    windowStartMin: input.windowStartMin,
    windowEndMin: input.windowEndMin,
    monitorEvent: input.monitorEvent,
    pattern: input.pattern,
    peakDeviation: input.peakDeviation,
    support: input.support,
    falseAlarmRate: input.falseAlarmRate,
    version: input.version,
    abnormal: input.abnormal,
    seq: nextSeq,
  }
  const sources = [...(previous?.sources ?? []), source]
  const verdict = buildVerdict(input.configId, input.periodName, sources, strategy, now, previous)
  return {
    ok: true,
    message: `来源 ${source.sourceId} 已收录到时段 ${input.periodName} 的归并结论`,
    verdict,
    verdicts: { ...verdicts, [key]: verdict },
    seq: nextSeq + 1,
  }
}

/** 仅重算受影响时段；其余时段结论原样保留（跨模块更新时沿用原版本）。 */
export function recomputeScoped(
  verdicts: Record<string, AnomalyPeriodVerdict>,
  scopes: { configId: string; periodName: string }[],
  strategy: MergeStrategy,
  now: string,
): Record<string, AnomalyPeriodVerdict> {
  const next = { ...verdicts }
  for (const scope of scopes) {
    const key = periodKeyOf(scope.configId, scope.periodName)
    const previous = next[key]
    if (!previous) {
      continue
    }
    next[key] = buildVerdict(
      scope.configId,
      scope.periodName,
      previous.sources,
      strategy,
      now,
      previous,
    )
  }
  return next
}

/** 切换仲裁策略：结论数量与来源不变，只重建两种对照表；当前异常仍只出现一次。 */
export function reArbitrate(
  verdicts: Record<string, AnomalyPeriodVerdict>,
  strategy: MergeStrategy,
  now: string,
): Record<string, AnomalyPeriodVerdict> {
  const next: Record<string, AnomalyPeriodVerdict> = {}
  for (const [key, verdict] of Object.entries(verdicts)) {
    next[key] = {
      ...verdict,
      strategy,
      mergedAt: now,
      eventGroups: mergeByEvent(verdict.sources),
      windowGroups: mergeByWindow(verdict.sources),
    }
  }
  return next
}

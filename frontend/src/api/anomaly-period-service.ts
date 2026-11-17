/**
 * 异常时段判定清单服务：页面只通过这里读写，承接增量重算、幂等提交与跨模块联动。
 *
 * 调用链核对：
 * - 时段分析（timewindow 页面）→ local-service.runAction 改时段配置 → 本服务 applyConfigChange
 *   → 只重算受影响异常时段清单，未受影响时段沿用原版本；
 * - 异常检测（anomaly 页面）→ 本服务 submitDetection / recomputeAffected / 切换仲裁；
 * - 时段异常联动入口（timewindow 页面）复用本服务 listVerdicts，不另起一份数据。
 */
import {
  buildVerdict,
  mergeByEvent,
  mergeByWindow,
  mergeSource,
  periodKeyOf,
  reArbitrate,
  recomputeScoped,
} from '@/data/anomaly-period/engine'
import {
  loadState,
  resetState,
  saveState,
  type AnomalyPeriodState,
} from '@/data/anomaly-period/store'
import type {
  AnomalyPeriodVerdict,
  ConfigChangeInput,
  MergeStrategy,
  RecomputeScope,
  SubmitResult,
  SubmitSourceInput,
} from '@/data/anomaly-period/types'

function nowIso(): string {
  return new Date().toISOString()
}

export function listVerdicts(): AnomalyPeriodVerdict[] {
  const { verdicts } = loadState()
  return Object.values(verdicts).sort((a, b) => b.mergedAt.localeCompare(a.mergedAt))
}

export function getVerdict(configId: string, periodName: string): AnomalyPeriodVerdict | undefined {
  const { verdicts } = loadState()
  return verdicts[periodKeyOf(configId, periodName)]
}

export function currentStrategy(): MergeStrategy {
  return loadState().strategy
}

/**
 * 提交一次检测器判定（增量写入异常时段判定数据清单）。
 * 重复请求只写入一次，另一请求被拒绝；重叠窗口的后到检测复用已收录来源。
 */
export function submitDetection(input: SubmitSourceInput): SubmitResult {
  const state = loadState()

  // 跨会话幂等兜底：同一 requestId 已处理过，直接拒绝，不写第二份。
  if (state.handledRequests.includes(input.requestId)) {
    const verdict = getVerdict(input.configId, input.periodName)
    const reused = verdict?.sources.find((source) => source.requestId === input.requestId)
    return {
      ok: false,
      message: `重复提交已拒绝：请求 ${input.requestId} 已写入过异常时段判定清单`,
      reusedSourceId: reused?.sourceId,
      verdict,
    }
  }

  const outcome = mergeSource(state.verdicts, input, state.strategy, state.nextSeq, nowIso())
  const nextState: AnomalyPeriodState = {
    ...state,
    verdicts: outcome.verdicts,
    nextSeq: outcome.seq,
    handledRequests: [...state.handledRequests, input.requestId],
  }
  saveState(nextState)
  return { ok: outcome.ok, message: outcome.message, reusedSourceId: outcome.reusedSourceId, verdict: outcome.verdict }
}

/**
 * 受影响范围重算：误报率等结论数据只随受影响范围重算，来源（检测出处）原样保留。
 * 范围之外的时段完全不触碰，沿用原版本。
 */
export function recomputeAffected(scopes: RecomputeScope[]): {
  ok: boolean
  message: string
  verdicts: AnomalyPeriodVerdict[]
} {
  const state = loadState()
  const existingKeys = new Set(Object.keys(state.verdicts))
  const valid = scopes.filter((scope) =>
    existingKeys.has(periodKeyOf(scope.configId, scope.periodName)),
  )
  if (valid.length === 0) {
    return { ok: false, message: '受影响时段在当前异常判定清单中没有对应结论，无需重算', verdicts: listVerdicts() }
  }
  const verdicts = recomputeScoped(state.verdicts, valid, state.strategy, nowIso())
  saveState({ ...state, verdicts })
  return {
    ok: true,
    message: `已按受影响范围重算 ${valid.length} 个时段，其余时段沿用原版本，检测来源全部保留`,
    verdicts: listVerdicts(),
  }
}

/**
 * 跨模块更新：时段配置变更落在异常检测时调用。
 * 只修改受影响异常时段清单；未受影响时段配置沿用原版本。
 * 返回受影响结论，供「时段异常联动」入口直接复用。
 */
export function applyConfigChange(change: ConfigChangeInput): {
  ok: boolean
  message: string
  affected: AnomalyPeriodVerdict[]
} {
  const state = loadState()
  const scopes = change.affectedPeriods.map((periodName) => ({
    configId: change.configId,
    periodName,
  }))
  const before = Object.keys(state.verdicts).length
  const verdicts = recomputeScoped(state.verdicts, scopes, state.strategy, nowIso())
  // 给受影响时段打上配置新版本：仅这些时段版本抬升，其它时段保持不动。
  for (const periodName of change.affectedPeriods) {
    const key = periodKeyOf(change.configId, periodName)
    const verdict = verdicts[key]
    if (verdict) {
      verdicts[key] = { ...verdict, version: Math.max(verdict.version, change.version), mergedAt: nowIso() }
    }
  }
  saveState({ ...state, verdicts })
  const affected = change.affectedPeriods
    .map((periodName) => verdicts[periodKeyOf(change.configId, periodName)])
    .filter((verdict): verdict is AnomalyPeriodVerdict => Boolean(verdict))
  return {
    ok: affected.length > 0,
    message:
      affected.length > 0
        ? `时段配置 ${change.configId} 变更已联动：仅重算 ${affected.length}/${before} 个受影响异常时段，其余沿用原版本`
        : `时段配置 ${change.configId} 变更未命中异常时段清单，当前无联动重算`,
    affected,
  }
}

/** 版本冲突仲裁：在「监控事件归并 / 检测窗口归并」间切换，来源与结论数量不变。 */
export function switchStrategy(strategy: MergeStrategy): {
  ok: boolean
  message: string
  verdicts: AnomalyPeriodVerdict[]
} {
  const state = loadState()
  if (state.strategy === strategy) {
    return { ok: false, message: `仲裁策略已经是「${strategy === 'event' ? '监控事件归并' : '检测窗口归并'}」`, verdicts: listVerdicts() }
  }
  const verdicts = reArbitrate(state.verdicts, strategy, nowIso())
  saveState({ ...state, strategy, verdicts })
  return {
    ok: true,
    message:
      strategy === 'event'
        ? '已切换为按事件合并的告警来源清单：同一监控事件的来源合并，当前异常仍只出现一次'
        : '已切换为按窗口合并的峰值偏差对照表：同一检测窗口取峰值对照，来源可展开回查',
    verdicts: listVerdicts(),
  }
}

/** 单条结论的两种对照表实时读取（供展开回查）。 */
export function describeVerdict(verdict: AnomalyPeriodVerdict): {
  eventGroups: AnomalyPeriodVerdict['eventGroups']
  windowGroups: AnomalyPeriodVerdict['windowGroups']
} {
  return {
    eventGroups: mergeByEvent(verdict.sources),
    windowGroups: mergeByWindow(verdict.sources),
  }
}

/** 由当前检测器与时段配置数据生成一次模拟判定输入：串联 timewindow→anomaly 调用链。 */
export function buildDetectionInput(
  detector: {
    detectorId: string
    monitorEvent: string
    pattern: string
    falseAlarmRate: number
    minSupport: number
    windowMinutes: number
    version: number
    abnormal: boolean
    peakDeviation: number
  },
  config: { configId: string; periodName: string; startMin: number },
  requestId: string,
): SubmitSourceInput {
  return {
    requestId,
    detectorId: detector.detectorId,
    configId: config.configId,
    periodName: config.periodName,
    windowStartMin: config.startMin,
    windowEndMin: config.startMin + detector.windowMinutes,
    monitorEvent: detector.monitorEvent,
    pattern: detector.pattern,
    peakDeviation: detector.peakDeviation,
    support: detector.minSupport,
    falseAlarmRate: detector.falseAlarmRate,
    version: detector.version,
    abnormal: detector.abnormal,
  }
}

export function resetAnomalyPeriods(): AnomalyPeriodVerdict[] {
  return Object.values(resetState().verdicts)
}

/** 供单测在无 localStorage 环境注入初始状态。 */
export function seedStateForTest(state: AnomalyPeriodState): void {
  saveState(state)
}

export { buildVerdict }

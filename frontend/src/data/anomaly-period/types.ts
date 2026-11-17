/**
 * 增量更新的异常时段判定数据清单 —— 领域类型。
 *
 * 背景：同一份时段配置与检测器数据会被多个检测器、多个重叠检测窗口在同一时段重复读取。
 * 若每个检测器各自落一条判定，就会把同一处异常重复判成多份清单记录，噪声和重复告警持续增加。
 * 这里把「检测来源（单次判定）」与「时段归并结论（一个时段只保留一条当前结论）」分开建模：
 * - 来源永远保留，可展开回查；
 * - 结论按时段归并，当前异常只出现一次。
 */

/** 归并仲裁策略：重叠检测窗口与迟到支持量更新落在同一时段、发生版本冲突时二选一。 */
export type MergeStrategy = 'event' | 'window'

/** 一条检测来源：某个检测器在某次窗口计算/支持量更新里对某时段做出的单次判定。 */
export type AnomalySource = {
  /** 来源唯一编号，提交时去重的幂等键之一。 */
  sourceId: string
  /** 幂等请求号：同一请求重复提交时只写入一次。 */
  requestId: string
  /** 产生该判定的检测器编号，如 ANOM-0001。 */
  detectorId: string
  /** 检测器本次读取并用于判定的时段配置编号，如 TIME-0001。 */
  configId: string
  /** 命中的时段名称（与时段配置版本对齐，便于回查）。 */
  periodName: string
  /** 检测窗口的覆盖区间（分钟为单位，允许两个窗口重叠）。 */
  windowStartMin: number
  windowEndMin: number
  /** 监控事件：事件归并时按它聚合来源。 */
  monitorEvent: string
  /** 异常模式，如突增/突降/漂移。 */
  pattern: string
  /** 峰值偏差：窗口归并时按它取峰值对照。 */
  peakDeviation: number
  /** 本次判定时的支持量（最小支持量口径），迟到更新会带来新的版本。 */
  support: number
  /** 检测器误报率：仅随受影响范围重算，保留来源时不被摊薄。 */
  falseAlarmRate: number
  /** 数据/配置版本号，用于版本冲突仲裁。 */
  version: number
  /** 是否判定为异常。 */
  abnormal: boolean
  /** 该来源被收录的顺序号（先到先得，后到复用）。 */
  seq: number
}

/** 按事件合并的告警来源清单（event 仲裁视图的一行）。 */
export type EventMergedRow = {
  monitorEvent: string
  /** 该事件下参与归并的全部来源编号。 */
  sourceIds: string[]
  detectorIds: string[]
  pattern: string
  /** 取参与来源的最高版本作为事件当前版本。 */
  version: number
  /** 汇总峰值偏差。 */
  peakDeviation: number
}

/** 按窗口合并的峰值偏差对照表（window 仲裁视图的一行）。 */
export type WindowMergedRow = {
  windowStartMin: number
  windowEndMin: number
  sourceIds: string[]
  detectorIds: string[]
  /** 同一窗口区间内取峰值偏差最大的一条作为对照。 */
  peakDeviation: number
  monitorEvent: string
  version: number
}

/** 一个时段只保留一条的当前归并结论；来源全部保留且可展开。 */
export type AnomalyPeriodVerdict = {
  /** 归并键：时段配置 + 时段名称，同一时段只允许一条结论。 */
  periodKey: string
  configId: string
  periodName: string
  /** 已收录的全部检测来源（含迟到支持量更新），按 seq 排序。 */
  sources: AnomalySource[]
  /** 当前是否异常：只要任一有效来源判定异常即为异常，但结论只此一条。 */
  abnormal: boolean
  /** 受影响范围内重算后的误报率：来源级数据保留，结论级按来源汇总。 */
  falseAlarmRate: number
  /** 结论当前版本：取来源中的最高版本，单调不降。 */
  version: number
  /** 最近一次归并时间戳。 */
  mergedAt: string
  /** 当前生效的仲裁策略。 */
  strategy: MergeStrategy
  /** 按事件合并的告警来源清单。 */
  eventGroups: EventMergedRow[]
  /** 按窗口合并的峰值偏差对照表。 */
  windowGroups: WindowMergedRow[]
}

/** 提交一次检测判定的输入（来自检测器对时段配置的读取结果）。 */
export type SubmitSourceInput = {
  requestId: string
  detectorId: string
  configId: string
  periodName: string
  windowStartMin: number
  windowEndMin: number
  monitorEvent: string
  pattern: string
  peakDeviation: number
  support: number
  falseAlarmRate: number
  version: number
  abnormal: boolean
}

/** 提交结果：重复请求被拒绝时 ok=false，且不会重复增加当前告警。 */
export type SubmitResult = {
  ok: boolean
  message: string
  /** 命中已收录来源时复用该来源，而不是新增。 */
  reusedSourceId?: string
  verdict?: AnomalyPeriodVerdict
}

/** 受影响范围重算的输入：只给需要重算的时段，其余时段沿用原版本。 */
export type RecomputeScope = {
  configId: string
  periodName: string
}

/** 跨模块（时段配置）更新落在异常检测时的输入。 */
export type ConfigChangeInput = {
  configId: string
  /** 受影响的时段名称清单；清单之外的时段配置沿用原版本，不重算。 */
  affectedPeriods: string[]
  /** 配置新版本号。 */
  version: number
}

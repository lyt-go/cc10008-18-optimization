/**
 * 异常时段判定清单的本地持久化与示例播种。
 * 与既有 behavior-event-trace-hub:entries 分开存键，避免污染通用清单数据。
 */
import type { AnomalyPeriodVerdict, MergeStrategy } from './types'

const STORAGE_KEY = 'behavior-event-trace-hub:anomaly-period-verdicts'

export type AnomalyPeriodState = {
  verdicts: Record<string, AnomalyPeriodVerdict>
  /** 下一个来源序号，保证来源编号单调、可排序。 */
  nextSeq: number
  strategy: MergeStrategy
  /** 已处理过的请求号，跨会话兜底幂等（结论内也带 requestId，双保险）。 */
  handledRequests: string[]
}

/** 两个检测器覆盖同一时段、且窗口重叠的示例：验证只保留一条当前结论、来源可展开。 */
export function buildSeedState(): AnomalyPeriodState {
  const now = '2026-09-03T09:30:00.000Z'
  return {
    nextSeq: 5,
    strategy: 'event',
    handledRequests: ['REQ-SEED-1', 'REQ-SEED-2', 'REQ-SEED-3', 'REQ-SEED-4'],
    verdicts: {
      'TIME-0003::晚高峰时段': {
        periodKey: 'TIME-0003::晚高峰时段',
        configId: 'TIME-0003',
        periodName: '晚高峰时段',
        strategy: 'event',
        abnormal: true,
        falseAlarmRate: 0.065,
        version: 3,
        mergedAt: now,
        sources: [
          {
            sourceId: 'SRC-0001',
            requestId: 'REQ-SEED-1',
            detectorId: 'ANOM-0001',
            configId: 'TIME-0003',
            periodName: '晚高峰时段',
            windowStartMin: 1080,
            windowEndMin: 1200,
            monitorEvent: '点击事件',
            pattern: '突增',
            peakDeviation: 0.32,
            support: 1200,
            falseAlarmRate: 0.06,
            version: 2,
            abnormal: true,
            seq: 1,
          },
          {
            sourceId: 'SRC-0002',
            requestId: 'REQ-SEED-2',
            detectorId: 'ANOM-0002',
            configId: 'TIME-0003',
            periodName: '晚高峰时段',
            // 与上一条窗口重叠：同一时段两个检测器，只归并成一条结论。
            windowStartMin: 1140,
            windowEndMin: 1260,
            monitorEvent: '点击事件',
            pattern: '突增',
            peakDeviation: 0.41,
            support: 980,
            falseAlarmRate: 0.07,
            version: 3,
            abnormal: true,
            seq: 2,
          },
          {
            sourceId: 'SRC-0003',
            requestId: 'REQ-SEED-3',
            detectorId: 'ANOM-0001',
            configId: 'TIME-0003',
            periodName: '晚高峰时段',
            windowStartMin: 1080,
            windowEndMin: 1200,
            monitorEvent: '下单事件',
            pattern: '离群',
            peakDeviation: 0.18,
            support: 540,
            falseAlarmRate: 0.05,
            version: 2,
            abnormal: false,
            seq: 3,
          },
          {
            sourceId: 'SRC-0004',
            requestId: 'REQ-SEED-4',
            detectorId: 'ANOM-0003',
            configId: 'TIME-0003',
            periodName: '晚高峰时段',
            windowStartMin: 1140,
            windowEndMin: 1260,
            monitorEvent: '支付事件',
            pattern: '模式漂移',
            peakDeviation: 0.22,
            support: 760,
            falseAlarmRate: 0.08,
            version: 2,
            abnormal: false,
            seq: 4,
          },
        ],
        eventGroups: [
          {
            monitorEvent: '点击事件',
            sourceIds: ['SRC-0001', 'SRC-0002'],
            detectorIds: ['ANOM-0001', 'ANOM-0002'],
            pattern: '突增',
            version: 3,
            peakDeviation: 0.41,
          },
          {
            monitorEvent: '支付事件',
            sourceIds: ['SRC-0004'],
            detectorIds: ['ANOM-0003'],
            pattern: '模式漂移',
            version: 2,
            peakDeviation: 0.22,
          },
          {
            monitorEvent: '下单事件',
            sourceIds: ['SRC-0003'],
            detectorIds: ['ANOM-0001'],
            pattern: '离群',
            version: 2,
            peakDeviation: 0.18,
          },
        ],
        windowGroups: [
          {
            windowStartMin: 1080,
            windowEndMin: 1200,
            sourceIds: ['SRC-0001', 'SRC-0003'],
            detectorIds: ['ANOM-0001'],
            peakDeviation: 0.32,
            monitorEvent: '点击事件',
            version: 2,
          },
          {
            windowStartMin: 1140,
            windowEndMin: 1260,
            sourceIds: ['SRC-0002', 'SRC-0004'],
            detectorIds: ['ANOM-0002', 'ANOM-0003'],
            peakDeviation: 0.41,
            monitorEvent: '点击事件',
            version: 3,
          },
        ],
      },
    },
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

let cache: AnomalyPeriodState | null = null

export function storageKey(): string {
  return STORAGE_KEY
}

export function loadState(): AnomalyPeriodState {
  if (cache) {
    return cache
  }
  const fallback = buildSeedState()
  if (typeof window === 'undefined' || !window.localStorage) {
    cache = fallback
    return cache
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    cache = fallback
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return cache
  }
  try {
    const parsed = JSON.parse(raw) as AnomalyPeriodState
    cache = {
      verdicts: parsed.verdicts ?? {},
      nextSeq: typeof parsed.nextSeq === 'number' ? parsed.nextSeq : 1,
      strategy: parsed.strategy === 'window' ? 'window' : 'event',
      handledRequests: Array.isArray(parsed.handledRequests) ? parsed.handledRequests : [],
    }
  } catch {
    cache = fallback
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
  }
  return cache
}

export function saveState(state: AnomalyPeriodState): void {
  cache = state
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  }
}

export function resetState(): AnomalyPeriodState {
  const fresh = clone(buildSeedState())
  saveState(fresh)
  return fresh
}

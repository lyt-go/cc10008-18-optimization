<template>
  <section class="period-panel">
    <header class="panel-head">
      <div>
        <h3>增量更新的异常时段判定数据清单（结果归并）</h3>
        <p class="page-desc">
          同一份时段配置与检测器数据被多个检测器、重叠窗口重复读取时，只按时段归并出一条当前结论；
          检测来源全部保留，可展开回查，重复请求与迟到更新不再产生重复告警。
        </p>
      </div>
      <div class="panel-actions">
        <button class="btn" type="button" @click="recomputeAll">受影响范围重算</button>
        <button class="btn ghost" type="button" @click="resetPanel">重置示例数据</button>
      </div>
    </header>

    <div class="merge-toolbar">
      <span class="toolbar-label">版本冲突仲裁：</span>
      <button
        class="btn"
        type="button"
        :class="{ primary: strategy === 'event' }"
        @click="changeStrategy('event')"
      >
        监控事件归并 · 告警来源清单
      </button>
      <button
        class="btn"
        type="button"
        :class="{ primary: strategy === 'window' }"
        @click="changeStrategy('window')"
      >
        检测窗口归并 · 峰值偏差对照表
      </button>
      <span class="toolbar-hint">无论哪种仲裁，当前异常只出现一次且来源可展开回查</span>
    </div>

    <p v-if="message" :class="['panel-msg', messageOk ? 'ok-text' : 'error-text']">{{ message }}</p>

    <div class="stat-row">
      <article class="stat-card">
        <span class="stat-label">时段结论数（每时段一条）</span>
        <strong class="stat-value">{{ verdicts.length }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">当前异常结论</span>
        <strong class="stat-value">{{ abnormalCount }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">已收录检测来源</span>
        <strong class="stat-value">{{ sourceCount }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">当前仲裁策略</span>
        <strong class="stat-value">{{ strategy === 'event' ? '监控事件归并' : '检测窗口归并' }}</strong>
      </article>
    </div>

    <table class="data-table">
      <thead>
        <tr>
          <th>时段配置</th>
          <th>时段名称</th>
          <th>当前结论</th>
          <th>误报率（范围内重算）</th>
          <th>结论版本</th>
          <th>来源数</th>
          <th>最近归并时间</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        <template v-for="verdict in verdicts" :key="verdict.periodKey">
          <tr>
            <td>{{ verdict.configId }}</td>
            <td>{{ verdict.periodName }}</td>
            <td>
              <span :class="['verdict-tag', verdict.abnormal ? 'tag-abnormal' : 'tag-normal']">
                {{ verdict.abnormal ? '异常（仅一条当前结论）' : '正常' }}
              </span>
            </td>
            <td>{{ (verdict.falseAlarmRate * 100).toFixed(2) }}%</td>
            <td>v{{ verdict.version }}</td>
            <td>{{ verdict.sources.length }}</td>
            <td>{{ formatTime(verdict.mergedAt) }}</td>
            <td class="row-actions">
              <button class="link" type="button" @click="toggleExpand(verdict.periodKey)">
                {{ expandedKey === verdict.periodKey ? '收起来源' : `展开全部来源（${verdict.sources.length}）` }}
              </button>
              <button class="link" type="button" @click="recomputeOne(verdict)">受影响范围重算</button>
            </td>
          </tr>
          <tr v-if="expandedKey === verdict.periodKey">
            <td :colspan="8" class="expand-cell">
              <div class="expand-grid">
                <div>
                  <h4>检测来源清单（可展开回查，共 {{ verdict.sources.length }} 条）</h4>
                  <table class="data-table sub-table">
                    <thead>
                      <tr>
                        <th>来源编号</th>
                        <th>请求号</th>
                        <th>检测器</th>
                        <th>监控事件</th>
                        <th>窗口(分)</th>
                        <th>峰值偏差</th>
                        <th>支持量</th>
                        <th>误报率</th>
                        <th>版本</th>
                        <th>判定</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr v-for="source in verdict.sources" :key="source.sourceId">
                        <td>{{ source.sourceId }}</td>
                        <td>{{ source.requestId }}</td>
                        <td>{{ source.detectorId }}</td>
                        <td>{{ source.monitorEvent }}</td>
                        <td>{{ source.windowStartMin }}-{{ source.windowEndMin }}</td>
                        <td>{{ source.peakDeviation }}</td>
                        <td>{{ source.support }}</td>
                        <td>{{ (source.falseAlarmRate * 100).toFixed(2) }}%</td>
                        <td>v{{ source.version }}</td>
                        <td>{{ source.abnormal ? '异常' : '正常' }}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
                <div class="group-grid">
                  <div>
                    <h4>按事件合并的告警来源清单</h4>
                    <table class="data-table sub-table">
                      <thead>
                        <tr><th>监控事件</th><th>来源</th><th>检测器</th><th>模式</th><th>峰值偏差</th><th>版本</th></tr>
                      </thead>
                      <tbody>
                        <tr v-for="group in verdict.eventGroups" :key="group.monitorEvent">
                          <td>{{ group.monitorEvent }}</td>
                          <td>{{ group.sourceIds.join(', ') }}</td>
                          <td>{{ group.detectorIds.join(', ') }}</td>
                          <td>{{ group.pattern }}</td>
                          <td>{{ group.peakDeviation }}</td>
                          <td>v{{ group.version }}</td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                  <div>
                    <h4>按窗口合并的峰值偏差对照表</h4>
                    <table class="data-table sub-table">
                      <thead>
                        <tr><th>窗口(分)</th><th>来源</th><th>检测器</th><th>峰值事件</th><th>峰值偏差</th><th>版本</th></tr>
                      </thead>
                      <tbody>
                        <tr v-for="group in verdict.windowGroups" :key="`${group.windowStartMin}-${group.windowEndMin}`">
                          <td>{{ group.windowStartMin }}-{{ group.windowEndMin }}</td>
                          <td>{{ group.sourceIds.join(', ') }}</td>
                          <td>{{ group.detectorIds.join(', ') }}</td>
                          <td>{{ group.monitorEvent }}</td>
                          <td>{{ group.peakDeviation }}</td>
                          <td>v{{ group.version }}</td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            </td>
          </tr>
        </template>
        <tr v-if="!verdicts.length">
          <td colspan="8" class="empty-state">暂无异常时段判定清单</td>
        </tr>
      </tbody>
    </table>

    <form class="submit-form" @submit.prevent="submitForm">
      <h4>提交检测器判定（增量写入，requestId 相同的重复提交只写一次）</h4>
      <div class="form-grid">
        <label v-for="field in formFields" :key="field.key" class="form-item">
          <span>{{ field.label }}</span>
          <input
            v-if="field.type !== 'checkbox'"
            v-model="form[field.key]"
            :type="field.type"
            :placeholder="field.label"
          />
          <input v-else v-model="form.abnormal" type="checkbox" />
        </label>
      </div>
      <div class="form-actions">
        <button class="btn primary" type="submit">提交判定并归并</button>
        <button class="btn" type="button" @click="demoOverlap">演示：两个检测器覆盖同一时段</button>
        <button class="btn" type="button" @click="demoDuplicate">演示：重复提交被拒绝</button>
        <button class="btn" type="button" @click="demoLateSupport">演示：迟到支持量更新复用来源</button>
      </div>
    </form>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import {
  applyConfigChange,
  listVerdicts,
  recomputeAffected,
  resetAnomalyPeriods,
  submitDetection,
  switchStrategy,
} from '@/api/anomaly-period-service'
import type { AnomalyPeriodVerdict, MergeStrategy, SubmitSourceInput } from '@/data/anomaly-period/types'

type FormModel = {
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

const formFields: { key: keyof FormModel; label: string; type: string }[] = [
  { key: 'requestId', label: '请求号 requestId（幂等键）', type: 'text' },
  { key: 'detectorId', label: '检测器编号', type: 'text' },
  { key: 'configId', label: '时段配置编号', type: 'text' },
  { key: 'periodName', label: '时段名称', type: 'text' },
  { key: 'windowStartMin', label: '窗口起始(分)', type: 'number' },
  { key: 'windowEndMin', label: '窗口结束(分)', type: 'number' },
  { key: 'monitorEvent', label: '监控事件', type: 'text' },
  { key: 'pattern', label: '异常模式', type: 'text' },
  { key: 'peakDeviation', label: '峰值偏差', type: 'number' },
  { key: 'support', label: '最小支持量', type: 'number' },
  { key: 'falseAlarmRate', label: '误报率(0-1)', type: 'number' },
  { key: 'version', label: '数据版本', type: 'number' },
  { key: 'abnormal', label: '判定异常', type: 'checkbox' },
]

function defaultForm(): FormModel {
  return {
    requestId: `REQ-${Date.now()}`,
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
    version: 1,
    abnormal: true,
  }
}

const verdicts = ref<AnomalyPeriodVerdict[]>([])
const expandedKey = ref<string>('')
const strategy = ref<MergeStrategy>('event')
const message = ref('')
const messageOk = ref(true)
const form = reactive<FormModel>(defaultForm())

const abnormalCount = computed(() => verdicts.value.filter((item) => item.abnormal).length)
const sourceCount = computed(() =>
  verdicts.value.reduce((sum, item) => sum + item.sources.length, 0),
)

function notify(ok: boolean, text: string): void {
  messageOk.value = ok
  message.value = text
}

function reload(): void {
  verdicts.value = listVerdicts()
  strategy.value = verdicts.value[0]?.strategy ?? 'event'
}

function toggleExpand(key: string): void {
  expandedKey.value = expandedKey.value === key ? '' : key
}

function changeStrategy(next: MergeStrategy): void {
  const result = switchStrategy(next)
  notify(result.ok, result.message)
  reload()
}

function toInput(model: FormModel): SubmitSourceInput {
  return {
    requestId: model.requestId,
    detectorId: model.detectorId,
    configId: model.configId,
    periodName: model.periodName,
    windowStartMin: Number(model.windowStartMin),
    windowEndMin: Number(model.windowEndMin),
    monitorEvent: model.monitorEvent,
    pattern: model.pattern,
    peakDeviation: Number(model.peakDeviation),
    support: Number(model.support),
    falseAlarmRate: Number(model.falseAlarmRate),
    version: Number(model.version),
    abnormal: model.abnormal,
  }
}

function submitForm(): void {
  const result = submitDetection(toInput(form))
  notify(result.ok, result.message)
  reload()
  form.requestId = `REQ-${Date.now()}`
}

function recomputeOne(verdict: AnomalyPeriodVerdict): void {
  const result = recomputeAffected([
    { configId: verdict.configId, periodName: verdict.periodName },
  ])
  notify(result.ok, result.message)
  reload()
}

function recomputeAll(): void {
  const result = recomputeAffected(
    verdicts.value.map((verdict) => ({
      configId: verdict.configId,
      periodName: verdict.periodName,
    })),
  )
  notify(result.ok, result.message)
  reload()
}

function resetPanel(): void {
  resetAnomalyPeriods()
  expandedKey.value = ''
  reload()
  notify(true, '已恢复示例归并数据')
}

/** 演示：两个检测器覆盖同一时段、窗口重叠 —— 清单只保留一条结论并能展开全部来源。 */
function demoOverlap(): void {
  const stamp = Date.now()
  const common = {
    configId: 'TIME-0003',
    periodName: '晚高峰时段',
    monitorEvent: '曝光事件',
    pattern: '突增',
    falseAlarmRate: 0.05,
    abnormal: true,
  }
  const first = submitDetection({
    ...common,
    requestId: `REQ-OVL-${stamp}-A`,
    detectorId: 'ANOM-0010',
    windowStartMin: 1200,
    windowEndMin: 1320,
    peakDeviation: 0.28,
    support: 800,
    version: 1,
  })
  const second = submitDetection({
    ...common,
    requestId: `REQ-OVL-${stamp}-B`,
    detectorId: 'ANOM-0011',
    windowStartMin: 1260,
    windowEndMin: 1380,
    peakDeviation: 0.37,
    support: 760,
    version: 2,
  })
  reload()
  expandedKey.value = 'TIME-0003::晚高峰时段'
  notify(
    first.ok && second.ok,
    `两个检测器已归并为一条结论：${first.message}；${second.message}`,
  )
}

/** 演示：同一请求重复提交，只写入一次，另一请求被拒绝。 */
function demoDuplicate(): void {
  const requestId = `REQ-DUP-${Date.now()}`
  const payload: SubmitSourceInput = {
    requestId,
    detectorId: 'ANOM-0002',
    configId: 'TIME-0003',
    periodName: '晚高峰时段',
    windowStartMin: 1080,
    windowEndMin: 1200,
    monitorEvent: '滚动事件',
    pattern: '离群',
    peakDeviation: 0.21,
    support: 500,
    falseAlarmRate: 0.07,
    version: 1,
    abnormal: true,
  }
  const first = submitDetection(payload)
  const second = submitDetection({ ...payload })
  reload()
  notify(second.ok === false, `首次：${first.message}；重复请求：${second.message}`)
}

/** 演示：重叠检测窗口与迟到支持量更新落在同一时段，复用来源而非新增告警。 */
function demoLateSupport(): void {
  const result = submitDetection({
    requestId: `REQ-LATE-${Date.now()}`,
    detectorId: 'ANOM-0001',
    configId: 'TIME-0003',
    periodName: '晚高峰时段',
    windowStartMin: 1080,
    windowEndMin: 1200,
    monitorEvent: '点击事件',
    pattern: '突增',
    peakDeviation: 0.46,
    support: 2600,
    falseAlarmRate: 0.06,
    version: 8,
    abnormal: true,
  })
  reload()
  expandedKey.value = 'TIME-0003::晚高峰时段'
  notify(result.ok, result.message)
}

/** 供时段分析联动入口复用：按配置触发跨模块更新。 */
function linkByConfig(configId: string, version: number): void {
  const affectedPeriods = verdicts.value
    .filter((verdict) => verdict.configId === configId)
    .map((verdict) => verdict.periodName)
  const result = applyConfigChange({ configId, affectedPeriods, version })
  notify(result.ok, result.message)
  reload()
}

function formatTime(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString('zh-CN', { hour12: false })
}

defineExpose({ linkByConfig, reload })

onMounted(reload)
</script>

<style scoped>
.period-panel {
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 14px 16px;
  margin-top: 18px;
}
.panel-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 12px;
}
.panel-head h3 {
  margin: 0 0 4px;
  font-size: 15px;
}
.merge-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin: 10px 0;
}
.toolbar-label {
  font-size: 13px;
  color: var(--muted);
}
.toolbar-hint {
  font-size: 12px;
  color: var(--muted);
}
.panel-msg {
  font-size: 13px;
  margin: 6px 0;
}
.ok-text {
  color: #067647;
}
.verdict-tag {
  border-radius: 999px;
  padding: 2px 10px;
  font-size: 12px;
}
.tag-abnormal {
  background: #fef3f2;
  color: #b42318;
}
.tag-normal {
  background: #ecfdf3;
  color: #067647;
}
.expand-cell {
  background: #f8fafc;
}
.expand-grid {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 8px;
}
.expand-grid h4,
.submit-form h4 {
  margin: 4px 0;
  font-size: 13px;
}
.group-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
.sub-table th,
.sub-table td {
  font-size: 12px;
  padding: 6px 8px;
}
.submit-form {
  margin-top: 14px;
  border-top: 1px dashed var(--border);
  padding-top: 12px;
}
.form-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 8px 12px;
  margin-bottom: 10px;
}
.form-item span {
  display: block;
  font-size: 12px;
  color: var(--muted);
  margin-bottom: 2px;
}
.form-item input {
  width: 100%;
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  font-size: 13px;
}
.form-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
</style>

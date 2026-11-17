<template>
  <section class="link-panel">
    <header class="link-head">
      <div>
        <h3>时段异常联动入口（复用异常检测同一份判定清单）</h3>
        <p class="page-desc">
          时段配置在本页发生状态流转时，跨模块更新只重算挂在该配置下的受影响异常时段清单，
          其余时段配置沿用原版本；这里不另起数据，直接读取异常检测的归并结论。
        </p>
      </div>
      <button class="btn" type="button" @click="reload">刷新联动清单</button>
    </header>

    <div class="stat-row">
      <article class="stat-card">
        <span class="stat-label">联动时段结论</span>
        <strong class="stat-value">{{ verdicts.length }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">其中异常结论</span>
        <strong class="stat-value">{{ abnormalCount }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">可回查检测来源</span>
        <strong class="stat-value">{{ sourceCount }}</strong>
      </article>
    </div>

    <table class="data-table">
      <thead>
        <tr>
          <th>时段配置编号</th>
          <th>时段名称</th>
          <th>当前结论</th>
          <th>误报率</th>
          <th>版本</th>
          <th>来源检测器</th>
          <th>最近归并</th>
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
                {{ verdict.abnormal ? '异常（一条当前结论）' : '正常' }}
              </span>
            </td>
            <td>{{ (verdict.falseAlarmRate * 100).toFixed(2) }}%</td>
            <td>v{{ verdict.version }}</td>
            <td>{{ [...new Set(verdict.sources.map((source) => source.detectorId))].join(', ') }}</td>
            <td>{{ formatTime(verdict.mergedAt) }}</td>
            <td class="row-actions">
              <button class="link" type="button" @click="toggle(verdict.periodKey)">
                {{ expandedKey === verdict.periodKey ? '收起来源' : `展开来源（${verdict.sources.length}）` }}
              </button>
            </td>
          </tr>
          <tr v-if="expandedKey === verdict.periodKey">
            <td colspan="8" class="expand-cell">
              <table class="data-table sub-table">
                <thead>
                  <tr>
                    <th>来源编号</th>
                    <th>请求号</th>
                    <th>检测器</th>
                    <th>监控事件</th>
                    <th>窗口(分)</th>
                    <th>支持量</th>
                    <th>峰值偏差</th>
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
                    <td>{{ source.support }}</td>
                    <td>{{ source.peakDeviation }}</td>
                    <td>v{{ source.version }}</td>
                    <td>{{ source.abnormal ? '异常' : '正常' }}</td>
                  </tr>
                </tbody>
              </table>
            </td>
          </tr>
        </template>
        <tr v-if="!verdicts.length">
          <td colspan="8" class="empty-state">暂无联动的异常时段判定清单</td>
        </tr>
      </tbody>
    </table>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import { listVerdicts } from '@/api/anomaly-period-service'
import type { AnomalyPeriodVerdict } from '@/data/anomaly-period/types'

const verdicts = ref<AnomalyPeriodVerdict[]>([])
const expandedKey = ref('')

const abnormalCount = computed(() => verdicts.value.filter((item) => item.abnormal).length)
const sourceCount = computed(() =>
  verdicts.value.reduce((sum, item) => sum + item.sources.length, 0),
)

function toggle(key: string): void {
  expandedKey.value = expandedKey.value === key ? '' : key
}

function formatTime(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString('zh-CN', { hour12: false })
}

function reload(): void {
  verdicts.value = listVerdicts()
}

defineExpose({ reload })

onMounted(reload)
</script>

<style scoped>
.link-panel {
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 14px 16px;
  margin-top: 18px;
}
.link-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 12px;
}
.link-head h3 {
  margin: 0 0 4px;
  font-size: 15px;
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
.sub-table th,
.sub-table td {
  font-size: 12px;
  padding: 6px 8px;
}
</style>

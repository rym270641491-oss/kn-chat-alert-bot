'use strict'

const { buildDailyReport, formatDateTime } = require('./alert-report')

const GROUPS = Object.freeze([
  { source: 'infrastructure', title: '基础设施', configName: 'N9E_INFRASTRUCTURE_GROUP_ID' },
  { source: 'application', title: '应用组件', configName: 'N9E_APPLICATION_GROUP_ID' }
])

function required(value, name) {
  const normalized = String(value || '').trim()
  if (!normalized) throw new Error(`${name} is required`)
  return normalized
}

function integerSetting(env, name, fallback, { min, max }) {
  const value = Number(env[name] || fallback)
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`)
  }
  return value
}

function readN9eReportConfig(env = process.env) {
  return {
    apiBase: String(env.N9E_API_BASE || 'https://bigdata-alert.kuainiu.io').replace(/\/+$/, ''),
    token: required(env.N9E_TOKEN, 'N9E_TOKEN'),
    infrastructureGroupId: integerSetting(env, 'N9E_INFRASTRUCTURE_GROUP_ID', null, {
      min: 1,
      max: Number.MAX_SAFE_INTEGER
    }),
    applicationGroupId: integerSetting(env, 'N9E_APPLICATION_GROUP_ID', null, {
      min: 1,
      max: Number.MAX_SAFE_INTEGER
    }),
    requestTimeoutMs: integerSetting(env, 'N9E_REQUEST_TIMEOUT_MS', 15_000, {
      min: 1_000,
      max: 120_000
    }),
    pageSize: integerSetting(env, 'N9E_PAGE_SIZE', 100, { min: 1, max: 1_000 }),
    maxPages: integerSetting(env, 'N9E_MAX_PAGES', 100, { min: 1, max: 10_000 }),
    timeZone: String(env.REPORT_TIMEZONE || 'Asia/Shanghai'),
    reportTopN: integerSetting(env, 'REPORT_TOP_N', 3, { min: 1, max: 100 })
  }
}

function asDate(value) {
  if (value === undefined || value === null || value === '') return null
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : new Date(value)
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value > 10_000_000_000 ? value : value * 1000)
  }
  const text = String(value).trim()
  if (!text) return null
  if (/^\d+$/.test(text)) {
    const numeric = Number(text)
    return new Date(numeric > 10_000_000_000 ? numeric : numeric * 1000)
  }
  const parsed = new Date(text)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

function normalizeLabels(event) {
  if (event && event.tags_map && typeof event.tags_map === 'object' && !Array.isArray(event.tags_map)) {
    return Object.fromEntries(
      Object.entries(event.tags_map).map(([key, value]) => [String(key), String(value)])
    )
  }
  if (Array.isArray(event && event.tags)) {
    return Object.fromEntries(
      event.tags
        .filter((tag) => tag && typeof tag === 'object' && tag.key)
        .map((tag) => [String(tag.key), String(tag.value || '')])
    )
  }
  return {}
}

function groupJob(labels, event) {
  return labels.job || labels.src || labels.ident || String(event.rule_name || event.rule_id || '未标注')
}

function isRecovered(event) {
  return event && (event.is_recovered === true || event.is_recovered === 1 || event.is_recovered === '1')
}

function stableId(event, source, groupId, index) {
  const id = event && (event.id || event.event_id || event.hash)
  if (id !== undefined && id !== null && String(id).trim()) return `${source}:${id}`
  const labels = normalizeLabels(event)
  return `${source}:${groupId}:${event && (event.rule_id || event.rule_name || 'unknown')}:${JSON.stringify(labels)}:${index}`
}

function inExpectedBusinessGroup(event, groupId) {
  const eventGroupId = event && (event.group_id ?? event.bgid ?? event.business_group_id)
  return eventGroupId === undefined || eventGroupId === null || String(eventGroupId) === String(groupId)
}

function normalizeHistoryEvent(event, { source, groupId, index }) {
  if (!event || typeof event !== 'object') return []
  if (!inExpectedBusinessGroup(event, groupId)) return []

  const labels = normalizeLabels(event)
  const alertName = String(event.rule_name || event.name || '未命名告警')
  const baseId = stableId(event, source, groupId, index)
  const fingerprint = `${source}:${groupId}:${String(event.hash || baseId)}`
  const common = {
    source,
    sourceChatId: String(groupId),
    messageId: String(event.id || event.event_id || event.hash || baseId),
    alertName,
    level: String(event.severity || ''),
    labels,
    job: groupJob(labels, event),
    fingerprint,
    receivedAt: new Date().toISOString()
  }
  const normalized = []
  const triggerAt = asDate(event.first_trigger_time ?? event.trigger_time)
  if (triggerAt) {
    normalized.push({
      ...common,
      eventId: `${baseId}:trigger`,
      status: 'trigger',
      occurredAt: triggerAt.toISOString(),
      occurredAtText: triggerAt.toISOString(),
      sequence: 0
    })
  }
  const recoveryAt = asDate(event.recover_time)
  if (isRecovered(event) && recoveryAt) {
    normalized.push({
      ...common,
      eventId: `${baseId}:recovery`,
      status: 'recovery',
      occurredAt: recoveryAt.toISOString(),
      occurredAtText: recoveryAt.toISOString(),
      sequence: 1
    })
  }
  return normalized
}

function dedupeHistoryEvents(events) {
  const known = new Set()
  return events.filter((event, index) => {
    const key = event && (event.id || event.event_id || event.hash)
    const normalized = key === undefined || key === null || key === ''
      ? `no-id:${index}:${JSON.stringify(event)}`
      : `id:${key}`
    if (known.has(normalized)) return false
    known.add(normalized)
    return true
  })
}

function normalizeHistoryEvents(events, { source, groupId }) {
  return dedupeHistoryEvents(events).flatMap((event, index) =>
    normalizeHistoryEvent(event, { source, groupId, index })
  )
}

async function fetchN9eReportEvents({ client, from, to, config }) {
  const requests = GROUPS.map(async (group) => {
    const groupId = group.source === 'infrastructure'
      ? config.infrastructureGroupId
      : config.applicationGroupId
    const records = await client.listHistoryAlerts({
      from,
      to,
      businessGroupId: groupId,
      limit: config.pageSize,
      maxPages: config.maxPages
    })
    return {
      source: group.source,
      groupId,
      records,
      events: normalizeHistoryEvents(records, { source: group.source, groupId })
    }
  })
  const sources = await Promise.all(requests)
  return {
    events: sources.flatMap((source) => source.events),
    sourceCounts: Object.fromEntries(
      sources.map((source) => [source.source, source.records.length])
    )
  }
}

function buildN9eDailyReport({ events, from, to, asOf = to, timeZone, topN }) {
  return buildDailyReport({ events, from, to, asOf, timeZone, topN })
}

function describeWindow({ from, to, timeZone }) {
  return `${formatDateTime(from, timeZone)} 至 ${formatDateTime(to, timeZone)}`
}

module.exports = {
  GROUPS,
  asDate,
  buildN9eDailyReport,
  dedupeHistoryEvents,
  describeWindow,
  fetchN9eReportEvents,
  normalizeHistoryEvent,
  normalizeHistoryEvents,
  readN9eReportConfig
}

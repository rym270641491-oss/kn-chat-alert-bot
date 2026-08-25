'use strict'

const fs = require('node:fs/promises')
const path = require('node:path')

const formatterCache = new Map()

function getFormatter(timeZone) {
  if (!formatterCache.has(timeZone)) {
    formatterCache.set(
      timeZone,
      new Intl.DateTimeFormat('en-CA', {
        timeZone,
        calendar: 'iso8601',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23'
      })
    )
  }
  return formatterCache.get(timeZone)
}

function getZonedParts(date, timeZone) {
  const parts = getFormatter(timeZone).formatToParts(date)
  return Object.fromEntries(
    parts
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, Number(part.value)])
  )
}

function getTimeZoneOffsetMs(date, timeZone) {
  const parts = getZonedParts(date, timeZone)
  const zonedAsUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second
  )
  return zonedAsUtc - date.getTime()
}

function parseLocalTimestamp(value, timeZone) {
  if (!value) return null
  const match = String(value).trim().match(
    /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/
  )
  if (!match) return null

  const [, year, month, day, hour = '00', minute = '00', second = '00'] = match
  const wallClockAsUtc = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second)
  )
  const approximate = new Date(wallClockAsUtc)
  return new Date(wallClockAsUtc - getTimeZoneOffsetMs(approximate, timeZone))
}

function formatDateTime(date, timeZone) {
  const parts = getZonedParts(date, timeZone)
  const pad = (value) => String(value).padStart(2, '0')
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)} ${pad(parts.hour)}:${pad(parts.minute)}`
}

function formatDate(date, timeZone) {
  return formatDateTime(date, timeZone).slice(0, 10)
}

function shiftZonedDay(parts, days, timeZone) {
  const utcDate = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days))
  const shifted = getZonedParts(utcDate, 'UTC')
  return parseLocalTimestamp(
    `${shifted.year}-${String(shifted.month).padStart(2, '0')}-${String(shifted.day).padStart(2, '0')} ${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}:00`,
    timeZone
  )
}

function getLatestReportCutoff(now, reportHour, reportMinute, timeZone) {
  const current = getZonedParts(now, timeZone)
  const candidate = parseLocalTimestamp(
    `${current.year}-${String(current.month).padStart(2, '0')}-${String(current.day).padStart(2, '0')} ${String(reportHour).padStart(2, '0')}:${String(reportMinute).padStart(2, '0')}:00`,
    timeZone
  )

  if (candidate.getTime() > now.getTime()) {
    return shiftZonedDay(
      { ...current, hour: reportHour, minute: reportMinute },
      -1,
      timeZone
    )
  }
  return candidate
}

function getReportWindowForDate(
  reportDate,
  reportHour = 19,
  reportMinute = 0,
  timeZone = 'Asia/Shanghai'
) {
  const normalizedDate = String(reportDate || '').trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalizedDate)) {
    throw new Error('reportDate must use YYYY-MM-DD')
  }

  const to = parseLocalTimestamp(
    `${normalizedDate} ${String(reportHour).padStart(2, '0')}:${String(reportMinute).padStart(2, '0')}:00`,
    timeZone
  )
  if (!to || Number.isNaN(to.getTime()) || formatDate(to, timeZone) !== normalizedDate) {
    throw new Error(`invalid reportDate: ${normalizedDate}`)
  }

  const cutoffParts = getZonedParts(to, timeZone)
  const from = shiftZonedDay(
    { ...cutoffParts, hour: reportHour, minute: reportMinute },
    -1,
    timeZone
  )
  return { from, to, reportDate: normalizedDate }
}

function getLatestCompletedReportWindow(
  now,
  reportHour = 19,
  reportMinute = 0,
  timeZone = 'Asia/Shanghai'
) {
  const cutoff = getLatestReportCutoff(now, reportHour, reportMinute, timeZone)
  return getReportWindowForDate(
    formatDate(cutoff, timeZone),
    reportHour,
    reportMinute,
    timeZone
  )
}

function getCurrentReportWindowIfDue(
  now,
  reportHour = 19,
  reportMinute = 0,
  timeZone = 'Asia/Shanghai',
  graceMinutes = 0
) {
  const window = getReportWindowForDate(
    formatDate(now, timeZone),
    reportHour,
    reportMinute,
    timeZone
  )
  const eligibleAt = window.to.getTime() + graceMinutes * 60 * 1000
  return now.getTime() >= eligibleAt ? window : null
}

function cleanValue(value) {
  return String(value || '')
    .trim()
    .replace(/^`|`$/g, '')
    .replace(/\\([_*[\]()~`>#+\-=|{}.!])/g, '$1')
    .replace(/\u00a0/g, ' ')
    .trim()
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function readField(body, fieldName) {
  const regex = new RegExp(
    `^\\s*${escapeRegex(fieldName)}\\s*[:：]\\s*(.*?)\\s*$`,
    'mi'
  )
  const match = body.match(regex)
  return match ? cleanValue(match[1]) : ''
}

function readLabels(body) {
  const header = body.match(/^\s*标签\s*[:：]\s*$/mi)
  if (!header) return {}

  const labels = {}
  const labelBody = body.slice(header.index + header[0].length)
  for (const line of labelBody.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z][A-Za-z0-9_.-]*)\s*[:：]\s*(.*?)\s*$/)
    if (!match) continue
    labels[match[1]] = cleanValue(match[2])
  }
  return labels
}

function makeFingerprint(sourceChatId, alertName, labels) {
  const sortedLabels = Object.keys(labels)
    .sort()
    .map((key) => [key, labels[key]])
  return JSON.stringify([String(sourceChatId), alertName, sortedLabels])
}

function parseAlertMessage(
  text,
  {
    source,
    sourceChatId,
    messageId,
    receivedAt = new Date().toISOString(),
    timeZone = 'Asia/Shanghai'
  }
) {
  if (typeof text !== 'string') return []

  const headers = [
    ...text.matchAll(/^###\s*[^\n]*?告警(触发|恢复)[：:]\s*(.+?)\s*$/gm)
  ]

  return headers.map((header, index) => {
    const start = header.index + header[0].length
    const end = index + 1 < headers.length ? headers[index + 1].index : text.length
    const body = text.slice(start, end)
    const status = header[1] === '触发' ? 'trigger' : 'recovery'
    const alertName = cleanValue(header[2])
    const labels = readLabels(body)
    const occurredAtText = readField(body, status === 'trigger' ? '触发时间' : '恢复时间')
    const occurredAt = parseLocalTimestamp(occurredAtText, timeZone)
    const eventId = `${sourceChatId}:${messageId}:${index}`

    return {
      eventId,
      source,
      sourceChatId: String(sourceChatId),
      messageId,
      status,
      alertName,
      level: readField(body, '告警级别'),
      labels,
      // 基础设施示例没有 job，使用 src 作为可解释的统计分组兜底。
      job: labels.job || labels.src || '未标注',
      fingerprint: makeFingerprint(sourceChatId, alertName, labels),
      occurredAt: (occurredAt || new Date(receivedAt)).toISOString(),
      occurredAtText,
      receivedAt,
      sequence: index
    }
  })
}

function validTimestamp(value) {
  const timestamp = new Date(value).getTime()
  return Number.isNaN(timestamp) ? null : timestamp
}

function eventReceivedAt(event) {
  return validTimestamp(event.receivedAt)
}

// 报表按告警正文中的发生时间归属固定的 19:00–19:00 窗口。
// 无法解析正文时间的消息才按机器人接收时间兜底，避免数据静默丢失。
function eventTime(event) {
  return validTimestamp(event.occurredAt) ?? eventReceivedAt(event)
}

function findRecoveredTriggerIds(events, cutoff) {
  const cutoffMs = cutoff.getTime()
  const ordered = events
    .filter((event) => {
      const timestamp = eventTime(event)
      return timestamp !== null && timestamp <= cutoffMs
    })
    .slice()
    .sort(
      (left, right) =>
        eventTime(left) - eventTime(right) ||
        (left.sequence || 0) - (right.sequence || 0) ||
        (eventReceivedAt(left) || 0) - (eventReceivedAt(right) || 0)
    )

  const active = new Map()
  const recovered = new Set()
  for (const event of ordered) {
    const queue = active.get(event.fingerprint) || []
    if (event.status === 'trigger') {
      queue.push(event.eventId)
      active.set(event.fingerprint, queue)
      continue
    }

    const triggerId = queue.shift()
    if (triggerId) recovered.add(triggerId)
    if (queue.length === 0) active.delete(event.fingerprint)
    else active.set(event.fingerprint, queue)
  }
  return recovered
}

function hourBucket(event, timeZone) {
  const parts = getZonedParts(new Date(event.occurredAt || event.receivedAt), timeZone)
  const pad = (value) => String(value).padStart(2, '0')
  return `${pad(parts.hour)}:00-${pad((parts.hour + 1) % 24)}:00`
}

function aggregateSource(events, from, to, timeZone) {
  const fromMs = from.getTime()
  const toMs = to.getTime()
  const recovered = findRecoveredTriggerIds(events, to)
  const windowEvents = events.filter((event) => {
    const timestamp = eventTime(event)
    return timestamp !== null && timestamp > fromMs && timestamp <= toMs
  })
  const triggers = windowEvents.filter((event) => event.status === 'trigger')
  const recoveries = windowEvents.filter((event) => event.status === 'recovery')
  const unparsed = windowEvents.filter((event) => event.status === 'unparsed')
  const groups = new Map()

  for (const event of windowEvents) {
    const group = groups.get(event.job) || {
      job: event.job,
      total: 0,
      eventTotal: 0,
      recoveries: 0,
      unparsed: 0,
      unrecovered: 0,
      hours: new Map(),
      alertNames: new Map(),
      alertStats: new Map()
    }
    group.eventTotal += 1
    if (event.status === 'trigger') {
      group.total += 1
      if (!recovered.has(event.eventId)) group.unrecovered += 1
    } else if (event.status === 'recovery') {
      group.recoveries += 1
    } else {
      group.unparsed += 1
    }

    const hour = hourBucket(event, timeZone)
    group.hours.set(hour, (group.hours.get(hour) || 0) + 1)
    group.alertNames.set(event.alertName, (group.alertNames.get(event.alertName) || 0) + 1)
    const alertStat = group.alertStats.get(event.alertName) || {
      triggered: 0,
      recovered: 0,
      unparsed: 0,
      unrecovered: 0
    }
    if (event.status === 'trigger') {
      alertStat.triggered += 1
      if (!recovered.has(event.eventId)) alertStat.unrecovered += 1
    } else if (event.status === 'recovery') {
      alertStat.recovered += 1
    } else {
      alertStat.unparsed += 1
    }
    group.alertStats.set(event.alertName, alertStat)
    groups.set(event.job, group)
  }

  const normalizedGroups = [...groups.values()].map((group) => {
    const hours = [...group.hours.entries()].sort((left, right) => {
      return right[1] - left[1] || left[0].localeCompare(right[0])
    })
    const alertNames = [...group.alertNames.entries()].sort((left, right) => {
      return right[1] - left[1] || left[0].localeCompare(right[0])
    })
    const alertStats = [...group.alertStats.entries()].sort((left, right) => {
      return right[1].triggered - left[1].triggered || left[0].localeCompare(right[0])
    })
    return { ...group, hours, alertNames, alertStats }
  })

  normalizedGroups.sort(
    (left, right) => right.eventTotal - left.eventTotal || left.job.localeCompare(right.job)
  )
  return {
    total: triggers.length,
    recoveryTotal: recoveries.length,
    unparsedTotal: unparsed.length,
    receivedTotal: windowEvents.length,
    unrecovered: triggers.filter((event) => !recovered.has(event.eventId)).length,
    groups: normalizedGroups
  }
}

function formatCountList(items, suffix = '次') {
  return items.map(([name, count]) => `${name || '未命名'} (${count}${suffix})`).join('、')
}

function formatAlertStats(items) {
  return items
    .map(([name, stat]) => {
      const parts = [`触发${stat.triggered}次`, `恢复${stat.recovered}次`]
      if (stat.unparsed > 0) parts.push(`未解析${stat.unparsed}次`)
      parts.push(`未恢复${stat.unrecovered}次`)
      return `${name || '未命名'}（${parts.join('、')}）`
    })
    .join('、')
}

function renderSourceSection(title, events, from, to, timeZone, topN = 3) {
  const aggregate = aggregateSource(events, from, to, timeZone)
  const lines = [
    title,
    `📊 本时段事件：${aggregate.receivedTotal}条（触发${aggregate.total}次、恢复${aggregate.recoveryTotal}次、未解析${aggregate.unparsedTotal}次），未恢复${aggregate.unrecovered}次`
  ]

  if (aggregate.groups.length === 0) {
    lines.push('暂无接收的告警事件。')
    return lines.join('\n')
  }

  const visibleGroups = aggregate.groups.slice(0, topN)
  if (aggregate.groups.length > topN) {
    lines.push(`📌 以下展开告警次数最多的 Top ${topN} 个 job：`)
  }

  visibleGroups.forEach((group, index) => {
    const peak = group.hours[0]
    lines.push('')
    lines.push(`${index + 1}. job：${group.job}`)
    lines.push(
      `   📊 共${group.eventTotal}条：触发${group.total}次、恢复${group.recoveries}次、未解析${group.unparsed}次，未恢复${group.unrecovered}次`
    )
    lines.push('   🔍 统计分析：')
    lines.push(`   • 峰值时段：${peak[0]}（${peak[1]}次）`)
    lines.push(`   • 小时分布：${formatCountList(group.hours)}`)
    lines.push(
      `   • 告警内容：${group.alertStats.length ? formatAlertStats(group.alertStats) : '无'}`
    )
  })

  const omittedGroups = aggregate.groups.slice(topN)
  if (omittedGroups.length > 0) {
    const omittedTotal = omittedGroups.reduce((sum, group) => sum + group.eventTotal, 0)
    const omittedUnrecovered = omittedGroups.reduce(
      (sum, group) => sum + group.unrecovered,
      0
    )
    const omittedNames = omittedGroups.map((group) => group.job).join('、')
    lines.push('')
    lines.push(
      `其余 ${omittedGroups.length} 个 job 未展开：${omittedNames}；合计${omittedTotal}条事件，未恢复${omittedUnrecovered}次`
    )
  }

  return lines.join('\n')
}

function buildDailyReport({ events, from, to, timeZone = 'Asia/Shanghai', topN = 3 }) {
  const infrastructureEvents = events.filter((event) => event.source === 'infrastructure')
  const applicationEvents = events.filter((event) => event.source === 'application')
  return [
    '【告警分析汇报】',
    `读取时段：${formatDateTime(from, timeZone)} 至 ${formatDateTime(to, timeZone)}`,
    '',
    renderSourceSection('一、基础设施告警', infrastructureEvents, from, to, timeZone, topN),
    '',
    renderSourceSection('二、应用组件告警', applicationEvents, from, to, timeZone, topN)
  ].join('\n')
}

async function loadAlertState(filename) {
  try {
    const content = await fs.readFile(filename, 'utf8')
    const saved = JSON.parse(content)
    if (saved.lastReportAt && validTimestamp(saved.lastReportAt) === null) {
      throw new Error(`invalid lastReportAt in ${filename}`)
    }
    if (!Array.isArray(saved.events)) {
      throw new Error(`invalid events in ${filename}`)
    }
    if (
      saved.sentReportCutoffs !== undefined &&
      (!Array.isArray(saved.sentReportCutoffs) ||
        saved.sentReportCutoffs.some((cutoff) => validTimestamp(cutoff) === null))
    ) {
      throw new Error(`invalid sentReportCutoffs in ${filename}`)
    }
    return {
      lastReportAt: saved.lastReportAt || null,
      sentReportCutoffs: saved.sentReportCutoffs || [],
      events: saved.events
    }
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { lastReportAt: null, sentReportCutoffs: [], events: [] }
    }
    throw error
  }
}

async function saveAlertState(filename, state) {
  await fs.mkdir(path.dirname(filename), { recursive: true })
  const temporaryFile = `${filename}.tmp`
  await fs.writeFile(temporaryFile, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  await fs.rename(temporaryFile, filename)
}

class AlertStateStore {
  constructor(filename, state) {
    this.filename = filename
    this.state = state
    this.writeChain = Promise.resolve()
  }

  async initialize() {
    if (!Array.isArray(this.state.sentReportCutoffs)) {
      this.state.sentReportCutoffs = []
    }

    // 兼容旧状态文件：旧版 lastReportAt 表示已经成功发送过的截止点。
    if (
      this.state.lastReportAt &&
      !this.state.sentReportCutoffs.includes(this.state.lastReportAt)
    ) {
      this.state.sentReportCutoffs.push(this.state.lastReportAt)
      await this.save()
    }
  }

  async addEvents(events) {
    const known = new Set(this.state.events.map((event) => event.eventId))
    let added = 0
    for (const event of events) {
      if (known.has(event.eventId)) continue
      this.state.events.push(event)
      known.add(event.eventId)
      added += 1
    }
    if (added > 0) await this.save()
    return added
  }

  hasSentReport(cutoff) {
    const cutoffValue = cutoff.toISOString()
    return Array.isArray(this.state.sentReportCutoffs) &&
      this.state.sentReportCutoffs.includes(cutoffValue)
  }

  async markReportSent(cutoff) {
    const cutoffValue = cutoff.toISOString()
    if (!Array.isArray(this.state.sentReportCutoffs)) {
      this.state.sentReportCutoffs = []
    }
    if (this.hasSentReport(cutoff)) return false
    this.state.sentReportCutoffs.push(cutoffValue)
    // 保留这个字段，兼容已部署的旧状态文件；它不再作为下次日报的起点。
    this.state.lastReportAt = cutoffValue
    await this.save()
    return true
  }

  async pruneOldEvents(referenceCutoff, retentionDays) {
    if (!Number.isInteger(retentionDays) || retentionDays < 1) {
      throw new Error('retentionDays must be an integer of at least 1')
    }
    const threshold = referenceCutoff.getTime() - retentionDays * 24 * 60 * 60 * 1000
    const before = this.state.events.length
    this.state.events = this.state.events.filter((event) => {
      const timestamp = eventTime(event)
      return timestamp === null || timestamp >= threshold
    })
    this.state.sentReportCutoffs = this.state.sentReportCutoffs.filter((cutoff) => {
      const timestamp = validTimestamp(cutoff)
      return timestamp !== null && timestamp >= threshold
    })
    await this.save()
    return before - this.state.events.length
  }

  // 兼容旧调用方：报告成功后标记已发送，但仅按保留期清理旧事件。
  async finalizeReport(cutoff, retentionDays = 7) {
    await this.markReportSent(cutoff)
    return this.pruneOldEvents(cutoff, retentionDays)
  }

  async save() {
    this.writeChain = this.writeChain.then(() => saveAlertState(this.filename, this.state))
    return this.writeChain
  }
}

module.exports = {
  AlertStateStore,
  aggregateSource,
  buildDailyReport,
  formatDate,
  formatDateTime,
  getCurrentReportWindowIfDue,
  getLatestReportCutoff,
  getLatestCompletedReportWindow,
  getReportWindowForDate,
  loadAlertState,
  parseAlertMessage,
  parseLocalTimestamp,
  saveAlertState
}

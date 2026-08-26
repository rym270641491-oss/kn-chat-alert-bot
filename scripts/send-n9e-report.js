'use strict'

const {
  AlertStateStore,
  getCurrentReportingWindow,
  getLatestCompletedReportWindow,
  getReportWindowForDate,
  loadAlertState
} = require('../alert-report')
const { KnChatBotApi } = require('../bot')
const { N9eApi } = require('../n9e-client')
const {
  buildN9eDailyReport,
  fetchN9eReportEvents,
  readN9eReportConfig
} = require('../n9e-report')
const { loadEnvironmentFile } = require('./send-report')

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

function readOptions(args) {
  const options = { current: false, date: null, force: false, envFile: null, scheduled: false }
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--date') {
      options.date = args[index + 1]
      index += 1
    } else if (argument.startsWith('--date=')) {
      options.date = argument.slice('--date='.length)
    } else if (argument === '--env-file') {
      options.envFile = args[index + 1]
      index += 1
    } else if (argument.startsWith('--env-file=')) {
      options.envFile = argument.slice('--env-file='.length)
    } else if (argument === '--current') {
      options.current = true
    } else if (argument === '--scheduled') {
      options.scheduled = true
    } else if (argument === '--force') {
      options.force = true
    } else {
      throw new Error(`unknown option: ${argument}`)
    }
  }
  if (!options.date && args.includes('--date')) throw new Error('--date requires YYYY-MM-DD')
  if (!options.envFile && args.includes('--env-file')) throw new Error('--env-file requires a file path')
  if (options.current && options.date) throw new Error('--current cannot be used with --date')
  if (options.current && options.scheduled) throw new Error('--current cannot be used with --scheduled')
  return options
}

async function sendN9eReport({
  env = process.env,
  options = {},
  now = new Date(),
  n9eClient,
  chatApi
}) {
  const config = readN9eReportConfig(env)
  const reportHour = integerSetting(env, 'REPORT_HOUR', 19, { min: 0, max: 23 })
  const reportMinute = integerSetting(env, 'REPORT_MINUTE', 0, { min: 0, max: 59 })
  const normalizedOptions = { current: false, date: null, force: false, ...options }
  const window = normalizedOptions.current
    ? getCurrentReportingWindow(now, reportHour, reportMinute, config.timeZone)
    : normalizedOptions.date
      ? getReportWindowForDate(normalizedOptions.date, reportHour, reportMinute, config.timeZone)
      : getLatestCompletedReportWindow(now, reportHour, reportMinute, config.timeZone)
  const stateFile = String(env.N9E_REPORT_STATE_FILE || './data/n9e-report-state.json')
  const stateStore = new AlertStateStore(stateFile, await loadAlertState(stateFile))
  await stateStore.initialize()
  const isCurrent = normalizedOptions.current === true

  if (!isCurrent && stateStore.hasSentReport(window.to) && !normalizedOptions.force) {
    return { status: 'already_sent', window, sourceCounts: {} }
  }

  const dataTo = isCurrent ? new Date(now) : window.to
  const historyClient = n9eClient || new N9eApi({
    apiBase: config.apiBase,
    token: config.token,
    timeoutMs: config.requestTimeoutMs
  })
  const { events, sourceCounts } = await fetchN9eReportEvents({
    client: historyClient,
    from: window.from,
    to: dataTo,
    config
  })
  const report = buildN9eDailyReport({
    events,
    from: window.from,
    to: window.to,
    asOf: dataTo,
    timeZone: config.timeZone,
    topN: config.reportTopN
  })

  const sender = chatApi || new KnChatBotApi({
    apiBase: String(env.BOT_API_BASE || 'https://bot.kn.chat').replace(/\/+$/, ''),
    token: required(env.BOT_TOKEN, 'BOT_TOKEN')
  })
  await sender.call('sendMessage', {
    chat_id: required(env.REPORT_CHAT_ID, 'REPORT_CHAT_ID'),
    text: report
  })

  if (isCurrent) {
    return { status: 'sent_current', window, asOf: dataTo, sourceCounts, report }
  }

  await stateStore.markReportSent(window.to)
  const retentionDays = integerSetting(env, 'N9E_REPORT_STATE_RETENTION_DAYS', 30, {
    min: 1,
    max: 365
  })
  await stateStore.pruneOldEvents(window.to, retentionDays)
  return { status: 'sent', window, sourceCounts, report }
}

async function main() {
  const options = readOptions(process.argv.slice(2))
  const environmentFile = options.envFile || process.env.KN_CHAT_ALERT_ENV_FILE
  if (environmentFile) loadEnvironmentFile(environmentFile, process.env)

  const result = await sendN9eReport({ options })
  const counts = Object.entries(result.sourceCounts)
    .map(([source, count]) => `${source}:${count}`)
    .join(',')
  if (result.status === 'already_sent') {
    console.log(`n9e_report_already_sent cutoff=${result.window.to.toISOString()}`)
    return
  }
  if (result.status === 'sent_current') {
    console.log(
      `n9e_current_report_sent data_as_of=${result.asOf.toISOString()} source_records=${counts}`
    )
    return
  }
  console.log(`n9e_report_sent cutoff=${result.window.to.toISOString()} source_records=${counts}`)
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Nightingale 日报发送失败：${error.message}`)
    process.exitCode = 1
  })
}

module.exports = {
  readOptions,
  sendN9eReport
}

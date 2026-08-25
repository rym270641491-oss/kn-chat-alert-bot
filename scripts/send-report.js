'use strict'

const fs = require('node:fs')

const {
  AlertStateStore,
  buildDailyReport,
  getCurrentReportingWindow,
  getLatestCompletedReportWindow,
  getReportWindowForDate,
  loadAlertState
} = require('../alert-report')
const { KnChatBotApi } = require('../bot')

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

function loadEnvironmentFile(filename, env) {
  if (!filename) return
  const content = fs.readFileSync(filename, 'utf8')
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
    if (!match || env[match[1]] !== undefined) continue

    let value = match[2].trim()
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1)
    }
    env[match[1]] = value
  }
}

function readOptions(args) {
  const options = { current: false, date: null, force: false, envFile: null }
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
    } else if (argument === '--force') {
      options.force = true
    } else {
      throw new Error(`unknown option: ${argument}`)
    }
  }
  if (!options.date && args.includes('--date')) {
    throw new Error('--date requires YYYY-MM-DD')
  }
  if (!options.envFile && args.includes('--env-file')) {
    throw new Error('--env-file requires a file path')
  }
  if (options.current && options.date) {
    throw new Error('--current cannot be used with --date')
  }
  return options
}

async function sendReport({ env = process.env, options = {}, now = new Date(), api }) {
  const timeZone = String(env.REPORT_TIMEZONE || 'Asia/Shanghai')
  const reportHour = integerSetting(env, 'REPORT_HOUR', 19, { min: 0, max: 23 })
  const reportMinute = integerSetting(env, 'REPORT_MINUTE', 0, { min: 0, max: 59 })
  const retentionDays = integerSetting(env, 'REPORT_RETENTION_DAYS', 7, {
    min: 1,
    max: 90
  })
  const stateFile = String(env.ALERT_STATE_FILE || './data/alert-state.json')
  const isCurrentReport = options.current === true
  const window = isCurrentReport
    ? getCurrentReportingWindow(now, reportHour, reportMinute, timeZone)
    : options.date
      ? getReportWindowForDate(options.date, reportHour, reportMinute, timeZone)
      : getLatestCompletedReportWindow(now, reportHour, reportMinute, timeZone)
  const state = await loadAlertState(stateFile)
  const stateStore = new AlertStateStore(stateFile, state)
  await stateStore.initialize()

  if (!isCurrentReport && stateStore.hasSentReport(window.to) && !options.force) {
    return { status: 'already_sent', window, removed: 0 }
  }

  const report = buildDailyReport({
    events: state.events,
    from: window.from,
    to: window.to,
    asOf: isCurrentReport ? now : window.to,
    timeZone,
    topN: integerSetting(env, 'REPORT_TOP_N', 3, { min: 1, max: 100 })
  })
  const client = api || new KnChatBotApi({
    apiBase: String(env.BOT_API_BASE || 'https://bot.kn.chat').replace(/\/+$/, ''),
    token: required(env.BOT_TOKEN, 'BOT_TOKEN')
  })
  await client.call('sendMessage', {
    chat_id: required(env.REPORT_CHAT_ID, 'REPORT_CHAT_ID'),
    text: report
  })

  if (isCurrentReport) {
    return { status: 'sent_current', window, asOf: new Date(now), removed: 0 }
  }

  await stateStore.markReportSent(window.to)
  const removed = await stateStore.pruneOldEvents(window.to, retentionDays)
  return { status: 'sent', window, removed }
}

async function main() {
  const options = readOptions(process.argv.slice(2))
  const environmentFile = options.envFile || process.env.KN_CHAT_ALERT_ENV_FILE
  if (environmentFile) loadEnvironmentFile(environmentFile, process.env)

  const result = await sendReport({ options })
  if (result.status === 'already_sent') {
    console.log(`report_already_sent cutoff=${result.window.to.toISOString()}`)
    return
  }
  if (result.status === 'sent_current') {
    console.log(
      `current_report_sent window_end=${result.window.to.toISOString()} data_as_of=${result.asOf.toISOString()}`
    )
    return
  }
  console.log(
    `report_sent cutoff=${result.window.to.toISOString()} pruned_expired_events=${result.removed}`
  )
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`日报发送失败：${error.message}`)
    process.exitCode = 1
  })
}

module.exports = {
  loadEnvironmentFile,
  readOptions,
  sendReport
}

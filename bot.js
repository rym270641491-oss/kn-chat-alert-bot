'use strict'

const fs = require('node:fs/promises')
const path = require('node:path')

const {
  AlertStateStore,
  buildDailyReport,
  getCurrentReportWindowIfDue,
  loadAlertState,
  parseAlertMessage
} = require('./alert-report')

const DEFAULT_API_BASE = 'https://bot.kn.chat'

function requiredEnv(env, name) {
  const value = env[name] && String(env[name]).trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}

function integerEnv(env, name, fallback, { min = 0, max = Infinity } = {}) {
  const raw = env[name]
  if (raw === undefined || raw === '') return fallback

  const value = Number(raw)
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`)
  }
  return value
}

function readConfig(env = process.env) {
  // TARGET_CHAT_ID 作为旧原型的兼容别名，新的配置应使用两个来源群 ID。
  const infrastructureChatId = String(
    env.INFRASTRUCTURE_CHAT_ID || env.TARGET_CHAT_ID || ''
  ).trim()
  if (!infrastructureChatId) throw new Error('INFRASTRUCTURE_CHAT_ID is required')

  return {
    apiBase: String(env.BOT_API_BASE || DEFAULT_API_BASE).replace(/\/+$/, ''),
    token: requiredEnv(env, 'BOT_TOKEN'),
    infrastructureChatId,
    applicationChatId: requiredEnv(env, 'APPLICATION_CHAT_ID'),
    reportChatId: requiredEnv(env, 'REPORT_CHAT_ID'),
    startReply: String(
      env.START_REPLY || '你好，我是告警机器人。已收到 /start，当前群聊已接入。'
    ),
    offsetFile: String(env.OFFSET_FILE || './data/offset.json'),
    alertStateFile: String(env.ALERT_STATE_FILE || './data/alert-state.json'),
    pollTimeout: integerEnv(env, 'POLL_TIMEOUT', 20),
    pollLimit: integerEnv(env, 'POLL_LIMIT', 20, { min: 1, max: 100 }),
    retryDelayMs: integerEnv(env, 'RETRY_DELAY_MS', 3000),
    reportHour: integerEnv(env, 'REPORT_HOUR', 19, { min: 0, max: 23 }),
    reportMinute: integerEnv(env, 'REPORT_MINUTE', 0, { min: 0, max: 59 }),
    reportTopN: integerEnv(env, 'REPORT_TOP_N', 3, { min: 1, max: 100 }),
    reportTimeZone: String(env.REPORT_TIMEZONE || 'Asia/Shanghai'),
    // 截止点仍是 19:00；缓冲只让发送稍晚，以等待 long polling 中的消息落盘。
    reportGraceMinutes: integerEnv(env, 'REPORT_GRACE_MINUTES', 2, {
      min: 0,
      max: 60
    }),
    reportRetentionDays: integerEnv(env, 'REPORT_RETENTION_DAYS', 7, {
      min: 1,
      max: 90
    }),
    reportCheckIntervalMs: integerEnv(env, 'REPORT_CHECK_INTERVAL_MS', 15000, {
      min: 1000
    })
  }
}

class KnChatBotApi {
  constructor({ apiBase, token, fetchImpl = globalThis.fetch }) {
    if (typeof fetchImpl !== 'function') {
      throw new Error('Node.js 18+ with global fetch is required')
    }

    this.apiBase = apiBase.replace(/\/+$/, '')
    this.token = token
    this.fetch = fetchImpl
  }

  url(method) {
    return `${this.apiBase}/bot${this.token}/${method}`
  }

  async request(method, options = {}, requestUrl = this.url(method)) {
    let response
    try {
      response = await this.fetch(requestUrl, options)
    } catch (error) {
      throw new Error(`${method} network error: ${error.message}`, { cause: error })
    }

    let data
    try {
      data = await response.json()
    } catch (error) {
      throw new Error(`${method} returned invalid JSON`, { cause: error })
    }

    // KN Chat 文档要求检查 JSON 中的 ok，不能只依赖 HTTP 状态码。
    if (!response.ok || !data || data.ok !== true) {
      const description = data && data.description
        ? data.description
        : `HTTP ${response.status}`
      const apiError = new Error(`${method} failed: ${description}`)
      apiError.errorCode = data && data.error_code
      apiError.parameters = data && data.parameters
      throw apiError
    }

    return data.result
  }

  async call(method, body = {}) {
    return this.request(method, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
  }

  async getMe() {
    return this.request('getMe', { method: 'GET' })
  }

  async getUpdates({ offset, timeout, limit }) {
    const url = new URL(this.url('getUpdates'))
    url.searchParams.set('offset', String(offset))
    url.searchParams.set('timeout', String(timeout))
    url.searchParams.set('limit', String(limit))
    return this.request('getUpdates', { method: 'GET' }, url.toString())
  }
}

function parseCommand(message) {
  if (!message || typeof message.text !== 'string') return null

  const commandEntity = Array.isArray(message.entities)
    ? message.entities.find(
        (entity) => entity.type === 'bot_command' && entity.offset === 0
      )
    : null
  const firstToken = message.text.trim().split(/\s+/, 1)[0]
  const rawCommand = commandEntity
    ? message.text.slice(commandEntity.offset, commandEntity.offset + commandEntity.length)
    : firstToken
  const match = rawCommand.match(/^\/([A-Za-z0-9_]+)(?:@([A-Za-z0-9_]+))?$/)
  if (!match) return null

  return {
    name: match[1].toLowerCase(),
    username: match[2] ? match[2].toLowerCase() : null
  }
}

function isStartCommand(message, botUsername) {
  const command = parseCommand(message)
  if (!command || command.name !== 'start') return false
  if (command.username && botUsername) {
    return command.username === String(botUsername).toLowerCase()
  }
  return true
}

function isTargetGroupMessage(message, targetChatId) {
  if (!message || !message.chat) return false
  if (!['group', 'supergroup', 'channel'].includes(message.chat.type)) return false
  return String(message.chat.id) === String(targetChatId)
}

function sourceForChat(message, config) {
  if (!isTargetGroupMessage(message, message && message.chat && message.chat.id)) {
    return null
  }

  const chatId = String(message.chat.id)
  if (chatId === String(config.infrastructureChatId || config.targetChatId)) {
    return 'infrastructure'
  }
  if (chatId === String(config.applicationChatId)) return 'application'
  return null
}

function getUpdateMessage(update) {
  const fields = ['message', 'channel_post', 'edited_message', 'edited_channel_post']
  for (const field of fields) {
    if (update && update[field] && typeof update[field] === 'object') {
      return { message: update[field], updateType: field }
    }
  }
  return { message: null, updateType: null }
}

function getMessageText(message) {
  if (!message) return ''
  if (typeof message.text === 'string') return message.text
  if (typeof message.caption === 'string') return message.caption
  return ''
}

function getMessageReceivedAt(message, fallback = new Date()) {
  const date = message && message.date
  const candidate =
    typeof date === 'number'
      ? new Date(date * 1000)
      : typeof date === 'string'
        ? new Date(date)
        : new Date(fallback)

  return Number.isNaN(candidate.getTime())
    ? new Date(fallback).toISOString()
    : candidate.toISOString()
}

function isAlertLikeText(text) {
  return typeof text === 'string' && text.includes('告警')
}

function summarizeAlertText(text) {
  const line = String(text)
    .split(/\r?\n/)
    .map((item) => item.trim())
    .find((item) => item.includes('告警'))
  return (line || '未解析告警消息').replace(/^#+\s*/, '').slice(0, 120)
}

function makeUnparsedAlertEvent({ source, sourceChatId, messageId, text, receivedAt }) {
  const alertName = summarizeAlertText(text)
  return {
    eventId: `${sourceChatId}:${messageId}:unparsed`,
    source,
    sourceChatId: String(sourceChatId),
    messageId,
    status: 'unparsed',
    alertName,
    level: '',
    labels: {},
    job: '未解析',
    fingerprint: JSON.stringify([String(sourceChatId), alertName, []]),
    occurredAt: receivedAt,
    occurredAtText: '',
    receivedAt,
    sequence: 0
  }
}

async function loadOffset(filename) {
  try {
    const content = await fs.readFile(filename, 'utf8')
    const saved = JSON.parse(content)
    const offset = saved.next_offset
    if (!Number.isInteger(offset) || offset < 0) {
      throw new Error(`invalid next_offset in ${filename}`)
    }
    return offset
  } catch (error) {
    if (error.code === 'ENOENT') return 0
    throw error
  }
}

async function saveOffset(filename, nextOffset) {
  const directory = path.dirname(filename)
  await fs.mkdir(directory, { recursive: true })
  const temporaryFile = `${filename}.tmp`
  await fs.writeFile(
    temporaryFile,
    `${JSON.stringify({ next_offset: nextOffset }, null, 2)}\n`,
    'utf8'
  )
  await fs.rename(temporaryFile, filename)
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

async function handleUpdate(
  update,
  { api, config, botUsername, logger, stateStore, now = new Date() }
) {
  const { message, updateType } = getUpdateMessage(update)
  const updateId = update && update.update_id
  if (!message) {
    logger.info(`ignored update ${updateId ?? 'unknown'}: unsupported update payload`)
    return false
  }

  const source = sourceForChat(message, config)
  if (!source) {
    const chat = message.chat || {}
    logger.info(
      `ignored ${updateType} update ${updateId ?? 'unknown'}: chat ${chat.id ?? 'unknown'} type ${chat.type ?? 'unknown'} is not a configured source`
    )
    return false
  }

  let handled = false
  if (isStartCommand(message, botUsername)) {
    await api.call('sendMessage', {
      chat_id: message.chat.id,
      text: config.startReply,
      reply_to_message_id: message.message_id
    })
    logger.info(`replied to /start in chat ${message.chat.id}`)
    handled = true
  }

  const text = getMessageText(message)
  const receivedAt = getMessageReceivedAt(message, now)
  const events = parseAlertMessage(text, {
    source,
    sourceChatId: message.chat.id,
    messageId: message.message_id,
    receivedAt,
    timeZone: config.reportTimeZone
  })
  if (events.length > 0 && stateStore) {
    const added = await stateStore.addEvents(events)
    logger.info(
      `stored ${added} alert event(s) from ${source} chat ${message.chat.id} via ${updateType}`
    )
    handled = true
  } else if (isAlertLikeText(text) && stateStore) {
    const fallback = makeUnparsedAlertEvent({
      source,
      sourceChatId: message.chat.id,
      messageId: message.message_id,
      text,
      receivedAt
    })
    const added = await stateStore.addEvents([fallback])
    logger.info(
      `stored ${added} unparsed alert event(s) from ${source} chat ${message.chat.id} via ${updateType}`
    )
    handled = true
  } else if (!handled) {
    logger.info(
      `ignored ${updateType} update ${updateId ?? 'unknown'} from ${source} chat ${message.chat.id}: no alert block found`
    )
  }

  return handled
}

async function consumeUpdates({ api, config, logger, botUsername, stateStore, sleepImpl }) {
  let offset = await loadOffset(config.offsetFile)
  const wait = sleepImpl || sleep

  while (true) {
    let updates
    try {
      updates = await api.getUpdates({
        offset,
        timeout: config.pollTimeout,
        limit: config.pollLimit
      })
    } catch (error) {
      logger.error(error.message)
      await wait(config.retryDelayMs)
      continue
    }

    for (const update of updates) {
      try {
        // 只有业务处理和 offset 持久化成功后，才推进 offset。
        await handleUpdate(update, {
          api,
          config,
          botUsername,
          logger,
          stateStore
        })
        offset = update.update_id + 1
        await saveOffset(config.offsetFile, offset)
      } catch (error) {
        logger.error(`update ${update.update_id} failed: ${error.message}`)
        await wait(config.retryDelayMs)
        break
      }
    }
  }
}

async function runReportScheduler({ api, config, logger, stateStore, sleepImpl, nowImpl }) {
  const wait = sleepImpl || sleep
  const now = nowImpl || (() => new Date())

  while (true) {
    try {
      const current = now()
      const window = getCurrentReportWindowIfDue(
        current,
        config.reportHour,
        config.reportMinute,
        config.reportTimeZone,
        config.reportGraceMinutes
      )

      if (window && !stateStore.hasSentReport(window.to)) {
        const report = buildDailyReport({
          events: stateStore.state.events,
          from: window.from,
          to: window.to,
          timeZone: config.reportTimeZone,
          topN: config.reportTopN
        })
        await api.call('sendMessage', {
          chat_id: config.reportChatId,
          text: report
        })
        await stateStore.markReportSent(window.to)
        const removed = await stateStore.pruneOldEvents(
          window.to,
          config.reportRetentionDays
        )
        logger.info(
          `sent alert report for ${window.to.toISOString()}, retained ${config.reportRetentionDays} day(s), pruned ${removed} expired event(s)`
        )
      }
    } catch (error) {
      logger.error(`report failed: ${error.message}`)
    }

    await wait(config.reportCheckIntervalMs)
  }
}

async function runBot(config = readConfig(), dependencies = {}) {
  const logger = dependencies.logger || console
  const api = dependencies.api || new KnChatBotApi(config)
  const state = dependencies.state || await loadAlertState(config.alertStateFile)
  const stateStore = dependencies.stateStore || new AlertStateStore(config.alertStateFile, state)
  await stateStore.initialize()

  const me = await api.getMe()
  logger.info(`bot is running as @${me.username || me.first_name || me.id}`)
  logger.info(
    `listening to infrastructure ${config.infrastructureChatId}, application ${config.applicationChatId}`
  )
  logger.info(`report destination ${config.reportChatId} at ${config.reportHour}:${String(config.reportMinute).padStart(2, '0')}`)

  await Promise.all([
    consumeUpdates({
      api,
      config,
      logger,
      botUsername: me.username,
      stateStore,
      sleepImpl: dependencies.sleep
    }),
    runReportScheduler({
      api,
      config,
      logger,
      stateStore,
      sleepImpl: dependencies.sleep,
      nowImpl: dependencies.now
    })
  ])
}

if (require.main === module) {
  runBot().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}

module.exports = {
  AlertStateStore,
  KnChatBotApi,
  consumeUpdates,
  handleUpdate,
  getMessageReceivedAt,
  getUpdateMessage,
  isStartCommand,
  isTargetGroupMessage,
  makeUnparsedAlertEvent,
  loadAlertState,
  loadOffset,
  parseAlertMessage,
  parseCommand,
  readConfig,
  runBot,
  runReportScheduler,
  saveOffset,
  sourceForChat
}

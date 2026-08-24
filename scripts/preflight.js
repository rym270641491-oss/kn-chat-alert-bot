'use strict'

const fs = require('node:fs')
const { KnChatBotApi } = require('../bot')

const DEFAULT_ENV_FILE = '/Users/iris.y.ran/.config/kn-chat-alert-bot.env'

function loadEnvFile(filename) {
  if (!fs.existsSync(filename)) return

  const content = fs.readFileSync(filename, 'utf8')
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue

    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
    if (!match || process.env[match[1]] !== undefined) continue

    let value = match[2].trim()
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1)
    }
    process.env[match[1]] = value
  }
}

async function main() {
  loadEnvFile(process.env.KN_CHAT_ALERT_ENV_FILE || DEFAULT_ENV_FILE)

  const token = process.env.BOT_TOKEN && String(process.env.BOT_TOKEN).trim()
  if (!token) throw new Error('BOT_TOKEN is required')

  const apiBase = String(process.env.BOT_API_BASE || 'https://bot.kn.chat')
    .replace(/\/+$/, '')
  const api = new KnChatBotApi({ apiBase, token })
  const me = await api.getMe()

  console.log('KN Chat API preflight passed')
  console.log(`bot: @${me.username || me.first_name || me.id}`)
  console.log(`api: ${apiBase}`)
  console.log('chat_id: not checked yet')
}

main().catch((error) => {
  console.error(`KN Chat API preflight failed: ${error.message}`)
  process.exitCode = 1
})

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  handleUpdate,
  isStartCommand,
  isTargetGroupMessage,
  KnChatBotApi,
  parseCommand
} = require('../bot')

test('识别 /start 和群聊中的 /start@bot_username', () => {
  assert.deepEqual(parseCommand({ text: '/start' }), {
    name: 'start',
    username: null
  })
  assert.equal(
    isStartCommand({ text: '/start@alert_bot' }, 'alert_bot'),
    true
  )
  assert.equal(
    isStartCommand({ text: '/start@another_bot' }, 'alert_bot'),
    false
  )
})

test('只把目标 group/supergroup 视为可处理消息', () => {
  assert.equal(
    isTargetGroupMessage({ chat: { id: -1001, type: 'supergroup' } }, -1001),
    true
  )
  assert.equal(
    isTargetGroupMessage({ chat: { id: -1002, type: 'group' } }, -1001),
    false
  )
  assert.equal(
    isTargetGroupMessage({ chat: { id: -1001, type: 'private' } }, -1001),
    false
  )
})

test('不把相似文本误判为 /start', () => {
  assert.equal(isStartCommand({ text: '/started' }, 'alert_bot'), false)
  assert.equal(isStartCommand({ text: 'hello /start' }, 'alert_bot'), false)
  assert.equal(isStartCommand({ text: '普通消息' }, 'alert_bot'), false)
})

test('目标群的 /start 调用 sendMessage 并回复原消息', async () => {
  const calls = []
  const replied = await handleUpdate(
    {
      update_id: 101,
      message: {
        message_id: 7,
        chat: { id: -1001, type: 'supergroup' },
        text: '/start',
        entities: [{ offset: 0, length: 6, type: 'bot_command' }]
      }
    },
    {
      api: {
        async call(method, body) {
          calls.push({ method, body })
          return { message_id: 8 }
        }
      },
      config: {
        targetChatId: '-1001',
        startReply: '接入成功'
      },
      botUsername: 'alert_bot',
      logger: { info() {} }
    }
  )

  assert.equal(replied, true)
  assert.deepEqual(calls, [
    {
      method: 'sendMessage',
      body: {
        chat_id: -1001,
        text: '接入成功',
        reply_to_message_id: 7
      }
    }
  ])
})

test('getUpdates 带上 long polling 参数', async () => {
  let requestedUrl
  const api = new KnChatBotApi({
    apiBase: 'https://bot.kn.chat',
    token: 'test-token',
    fetchImpl: async (url) => {
      requestedUrl = String(url)
      return {
        ok: true,
        status: 200,
        async json() {
          return { ok: true, result: [] }
        }
      }
    }
  })

  await api.getUpdates({ offset: 11, timeout: 20, limit: 20 })
  const parsedUrl = new URL(requestedUrl)
  assert.equal(parsedUrl.pathname, '/bottest-token/getUpdates')
  assert.equal(parsedUrl.searchParams.get('offset'), '11')
  assert.equal(parsedUrl.searchParams.get('timeout'), '20')
  assert.equal(parsedUrl.searchParams.get('limit'), '20')
})

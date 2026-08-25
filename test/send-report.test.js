'use strict'

const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const assert = require('node:assert/strict')

const { parseAlertMessage, saveAlertState } = require('../alert-report')
const { sendReport } = require('../scripts/send-report')

const alertText = [
  '### 💔 告警触发：手动补发验证',
  '',
  '触发时间: 2026-08-25 18:39:53',
  '标签:',
  '  job: `manual-report-test`'
].join('\n')

const currentPeriodAlertText = [
  '### 💔 告警触发：当前统计日验证',
  '',
  '触发时间: 2026-08-25 20:11:53',
  '标签:',
  '  job: `current-period-test`'
].join('\n')

test('手动发送按指定 19:00 窗口生成日报，默认避免重复发送', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kn-chat-send-report-'))
  const stateFile = path.join(directory, 'alert-state.json')
  const events = parseAlertMessage(alertText, {
    source: 'application',
    sourceChatId: '-1002',
    messageId: 1,
    receivedAt: '2026-08-25T11:05:00.000Z'
  })
  const calls = []
  const api = {
    async call(method, body) {
      calls.push({ method, body })
      return { message_id: 1 }
    }
  }
  const env = {
    BOT_TOKEN: 'test-token',
    REPORT_CHAT_ID: '-1003',
    ALERT_STATE_FILE: stateFile,
    REPORT_TIMEZONE: 'Asia/Shanghai',
    REPORT_RETENTION_DAYS: '7'
  }

  try {
    await saveAlertState(stateFile, { lastReportAt: null, sentReportCutoffs: [], events })
    const first = await sendReport({
      env,
      options: { date: '2026-08-25', force: false },
      api
    })
    const second = await sendReport({
      env,
      options: { date: '2026-08-25', force: false },
      api
    })
    const resend = await sendReport({
      env,
      options: { date: '2026-08-25', force: true },
      api
    })

    assert.equal(first.status, 'sent')
    assert.equal(second.status, 'already_sent')
    assert.equal(resend.status, 'sent')
    assert.equal(calls.length, 2)
    assert.equal(calls[0].method, 'sendMessage')
    assert.equal(calls[0].body.chat_id, '-1003')
    assert.match(calls[0].body.text, /读取时段：2026-08-24 19:00 至 2026-08-25 19:00/)
    assert.match(calls[0].body.text, /手动补发验证/)
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})

test('当前统计日快报不标记已发送、不清理事件，并只统计截至执行时的数据', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kn-chat-current-report-'))
  const stateFile = path.join(directory, 'alert-state.json')
  const events = parseAlertMessage(currentPeriodAlertText, {
    source: 'application',
    sourceChatId: '-1002',
    messageId: 2,
    receivedAt: '2026-08-25T12:11:53.000Z'
  })
  const calls = []
  const api = {
    async call(method, body) {
      calls.push({ method, body })
      return { message_id: 2 }
    }
  }
  const env = {
    BOT_TOKEN: 'test-token',
    REPORT_CHAT_ID: '-1003',
    ALERT_STATE_FILE: stateFile,
    REPORT_TIMEZONE: 'Asia/Shanghai',
    REPORT_RETENTION_DAYS: '7'
  }

  try {
    await saveAlertState(stateFile, { lastReportAt: null, sentReportCutoffs: [], events })
    const result = await sendReport({
      env,
      options: { current: true, force: false },
      now: new Date('2026-08-25T12:15:00.000Z'),
      api
    })
    const saved = JSON.parse(await fs.readFile(stateFile, 'utf8'))

    assert.equal(result.status, 'sent_current')
    assert.equal(result.removed, 0)
    assert.equal(calls.length, 1)
    assert.match(calls[0].body.text, /读取时段：2026-08-25 19:00 至 2026-08-26 19:00/)
    assert.match(calls[0].body.text, /数据截至：2026-08-25 20:15（当前统计日快报，非完整日报）/)
    assert.match(calls[0].body.text, /当前统计日验证/)
    assert.deepEqual(saved.sentReportCutoffs, [])
    assert.equal(saved.events.length, 1)
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})

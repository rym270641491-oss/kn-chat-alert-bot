'use strict'

const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const assert = require('node:assert/strict')
const test = require('node:test')

const {
  buildN9eDailyReport,
  fetchN9eReportEvents,
  normalizeHistoryEvents
} = require('../n9e-report')
const { sendN9eReport } = require('../scripts/send-n9e-report')

function timestamp(value) {
  return Math.floor(new Date(value).getTime() / 1000)
}

function historyEvent(overrides = {}) {
  return {
    id: 101,
    hash: 'event-hash-101',
    group_id: 12,
    rule_name: '磁盘存储利用率80%',
    severity: 2,
    first_trigger_time: timestamp('2026-08-25T12:11:53.000Z'),
    is_recovered: 1,
    recover_time: timestamp('2026-08-25T12:12:53.000Z'),
    tags_map: { cn: 'mex', ident: 'bi-edw-mx-srdb-new-06', src: 'starrocks' },
    ...overrides
  }
}

test('Nightingale 历史事件转换为触发/恢复，按平台事件 ID 去重并拒绝串入的业务组', () => {
  const events = normalizeHistoryEvents(
    [
      historyEvent(),
      historyEvent(),
      historyEvent({ id: 102, group_id: 10 })
    ],
    { source: 'infrastructure', groupId: 12 }
  )

  assert.equal(events.length, 2)
  assert.deepEqual(events.map((event) => event.status), ['trigger', 'recovery'])
  assert.equal(events[0].source, 'infrastructure')
  assert.equal(events[0].job, 'starrocks')
  assert.equal(events[0].eventId, 'infrastructure:101:trigger')
})

test('日报直接使用两个业务组的历史告警，不依赖群消息或本地告警 JSON', async () => {
  const calls = []
  const client = {
    async listHistoryAlerts(input) {
      calls.push(input)
      if (input.businessGroupId === 12) return [historyEvent()]
      if (input.businessGroupId === 10) {
        return [historyEvent({
          id: 201,
          hash: 'event-hash-201',
          group_id: 10,
          rule_name: 'sr查询超时队列告警',
          is_recovered: 0,
          recover_time: 0,
          tags_map: { group: 'fe', job: 'cn-starrocks-new' }
        })]
      }
      throw new Error('unexpected business group')
    }
  }
  const config = {
    infrastructureGroupId: 12,
    applicationGroupId: 10,
    pageSize: 100,
    maxPages: 10
  }
  const from = new Date('2026-08-25T11:00:00.000Z')
  const to = new Date('2026-08-25T12:15:00.000Z')
  const result = await fetchN9eReportEvents({ client, from, to, config })
  const report = buildN9eDailyReport({
    events: result.events,
    from,
    to: new Date('2026-08-26T11:00:00.000Z'),
    asOf: to,
    timeZone: 'Asia/Shanghai',
    topN: 3
  })

  assert.deepEqual(calls.map((call) => call.businessGroupId).sort(), [10, 12])
  assert.equal(result.sourceCounts.infrastructure, 1)
  assert.equal(result.sourceCounts.application, 1)
  assert.match(report, /磁盘存储利用率80%（触发1次、恢复1次、未恢复0次）/)
  assert.match(report, /sr查询超时队列告警（触发1次、恢复0次、未恢复1次）/)
  assert.match(report, /当前统计日快报/)
})

test('当前统计日手动快报查询到执行时刻并可以重复发送', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'n9e-current-report-'))
  const reportState = path.join(directory, 'n9e-report-state.json')
  const queryCalls = []
  const sent = []
  const env = {
    N9E_API_BASE: 'https://bigdata-alert.example',
    N9E_TOKEN: 'n9e-test-token',
    N9E_INFRASTRUCTURE_GROUP_ID: '12',
    N9E_APPLICATION_GROUP_ID: '10',
    N9E_REPORT_STATE_FILE: reportState,
    BOT_TOKEN: 'kn-chat-test-token',
    REPORT_CHAT_ID: '-1003',
    REPORT_TIMEZONE: 'Asia/Shanghai'
  }
  const n9eClient = {
    async listHistoryAlerts(input) {
      queryCalls.push(input)
      return input.businessGroupId === 12 ? [historyEvent()] : []
    }
  }
  const chatApi = {
    async call(method, body) {
      sent.push({ method, body })
      return { message_id: 1 }
    }
  }

  try {
    const now = new Date('2026-08-25T12:15:00.000Z')
    const first = await sendN9eReport({
      env,
      options: { current: true },
      now,
      n9eClient,
      chatApi
    })
    const second = await sendN9eReport({
      env,
      options: { current: true },
      now,
      n9eClient,
      chatApi
    })

    assert.equal(first.status, 'sent_current')
    assert.equal(second.status, 'sent_current')
    assert.equal(sent.length, 2)
    assert.equal(queryCalls[0].from.toISOString(), '2026-08-25T11:00:00.000Z')
    assert.equal(queryCalls[0].to.toISOString(), '2026-08-25T12:15:00.000Z')
    assert.match(sent[0].body.text, /读取时段：2026-08-25 19:00 至 2026-08-26 19:00/)
    assert.match(sent[0].body.text, /磁盘存储利用率80%/)
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})

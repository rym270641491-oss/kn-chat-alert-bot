'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')

const { N9eApi } = require('../n9e-client')

test('历史告警查询只带指定业务组 ID、Unix 时间范围和分页参数', async () => {
  const calls = []
  const client = new N9eApi({
    apiBase: 'https://bigdata-alert.example',
    token: 'test-token',
    fetchImpl: async (url, options) => {
      calls.push({ url, options })
      return {
        ok: true,
        status: 200,
        async json() {
          return { dat: { list: [{ id: 1 }, { id: 2 }], total: 3 }, err: '' }
        }
      }
    }
  })

  const first = await client.listHistoryAlertPage({
    from: new Date('2026-08-25T11:00:00.000Z'),
    to: new Date('2026-08-26T11:00:00.000Z'),
    businessGroupId: 12,
    page: 2,
    limit: 100
  })

  assert.equal(first.total, 3)
  assert.equal(first.list.length, 2)
  const request = new URL(calls[0].url)
  assert.equal(request.pathname, '/api/n9e/alert-his-events/list')
  assert.equal(request.searchParams.get('bgid'), '12')
  assert.equal(request.searchParams.get('stime'), '1787655600')
  assert.equal(request.searchParams.get('etime'), '1787742000')
  assert.equal(request.searchParams.get('limit'), '100')
  assert.equal(request.searchParams.get('p'), '2')
  assert.equal(calls[0].options.headers['X-User-Token'], 'test-token')
})

test('历史告警分页合并后不额外请求其他业务组', async () => {
  const calls = []
  const client = new N9eApi({
    apiBase: 'https://bigdata-alert.example',
    token: 'test-token',
    fetchImpl: async (url) => {
      calls.push(new URL(url))
      const page = Number(calls[calls.length - 1].searchParams.get('p'))
      const pages = {
        1: [{ id: 1 }, { id: 2 }],
        2: [{ id: 3 }]
      }
      return {
        ok: true,
        status: 200,
        async json() {
          return { dat: { list: pages[page], total: 3 }, err: '' }
        }
      }
    }
  })

  const events = await client.listHistoryAlerts({
    from: new Date('2026-08-25T11:00:00.000Z'),
    to: new Date('2026-08-26T11:00:00.000Z'),
    businessGroupId: 10,
    limit: 2,
    maxPages: 3
  })

  assert.deepEqual(events.map((event) => event.id), [1, 2, 3])
  assert.deepEqual(calls.map((url) => url.searchParams.get('bgid')), ['10', '10'])
  assert.deepEqual(calls.map((url) => url.searchParams.get('p')), ['1', '2'])
})

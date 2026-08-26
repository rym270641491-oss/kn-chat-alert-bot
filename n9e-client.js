'use strict'

const DEFAULT_TIMEOUT_MS = 15_000

function required(value, name) {
  const normalized = String(value || '').trim()
  if (!normalized) throw new Error(`${name} is required`)
  return normalized
}

function positiveInteger(value, name, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const normalized = Number(value)
  if (!Number.isInteger(normalized) || normalized < min || normalized > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`)
  }
  return normalized
}

function unixSeconds(value, name) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) throw new Error(`${name} must be a valid date`)
  return Math.floor(date.getTime() / 1000)
}

function normalizePage(data) {
  if (!data || typeof data !== 'object' || !Array.isArray(data.list)) {
    throw new Error('Nightingale returned an invalid history-alert page')
  }
  const total = Number(data.total)
  if (!Number.isFinite(total) || total < 0) {
    throw new Error('Nightingale returned an invalid history-alert total')
  }
  return { list: data.list, total }
}

class N9eApi {
  constructor({ apiBase, token, fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS }) {
    if (typeof fetchImpl !== 'function') {
      throw new Error('Node.js 18+ with global fetch is required')
    }
    this.apiBase = required(apiBase, 'N9E_API_BASE').replace(/\/+$/, '')
    this.token = required(token, 'N9E_TOKEN')
    this.fetch = fetchImpl
    this.timeoutMs = positiveInteger(timeoutMs, 'N9E_REQUEST_TIMEOUT_MS', {
      min: 1_000,
      max: 120_000
    })
  }

  async request(pathname, searchParams = {}) {
    const url = new URL(pathname, `${this.apiBase}/`)
    for (const [key, value] of Object.entries(searchParams)) {
      if (value !== undefined && value !== null && value !== '') {
        url.searchParams.set(key, String(value))
      }
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs)
    let response
    try {
      response = await this.fetch(url.toString(), {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          'X-User-Token': this.token
        },
        signal: controller.signal
      })
    } catch (error) {
      const detail = error && error.name === 'AbortError' ? 'request timed out' : error.message
      throw new Error(`Nightingale history-alert request failed: ${detail}`, { cause: error })
    } finally {
      clearTimeout(timeout)
    }

    let payload
    try {
      payload = await response.json()
    } catch (error) {
      throw new Error('Nightingale returned invalid JSON', { cause: error })
    }
    if (!response.ok) {
      throw new Error(`Nightingale history-alert request failed: HTTP ${response.status}`)
    }
    if (!payload || typeof payload !== 'object') {
      throw new Error('Nightingale returned an invalid response')
    }
    if (payload.err) {
      throw new Error(`Nightingale history-alert request failed: ${payload.err}`)
    }
    return payload.dat
  }

  async listHistoryAlertPage({ from, to, businessGroupId, page = 1, limit = 100 }) {
    const groupId = positiveInteger(businessGroupId, 'businessGroupId')
    const pageNumber = positiveInteger(page, 'page', { min: 1, max: 100_000 })
    const pageSize = positiveInteger(limit, 'limit', { min: 1, max: 1_000 })
    const fromSeconds = unixSeconds(from, 'from')
    const toSeconds = unixSeconds(to, 'to')
    if (fromSeconds >= toSeconds) throw new Error('from must be before to')

    const pageData = await this.request('/api/n9e/alert-his-events/list', {
      stime: fromSeconds,
      etime: toSeconds,
      bgid: groupId,
      limit: pageSize,
      p: pageNumber
    })
    return normalizePage(pageData)
  }

  async listHistoryAlerts({ from, to, businessGroupId, limit = 100, maxPages = 100 }) {
    const pageSize = positiveInteger(limit, 'limit', { min: 1, max: 1_000 })
    const pageLimit = positiveInteger(maxPages, 'maxPages', { min: 1, max: 10_000 })
    const events = []
    let total = null

    for (let page = 1; page <= pageLimit; page += 1) {
      const result = await this.listHistoryAlertPage({
        from,
        to,
        businessGroupId,
        page,
        limit: pageSize
      })
      events.push(...result.list)
      total = result.total
      if (events.length >= total || result.list.length === 0) {
        return events.slice(0, total)
      }
    }
    throw new Error(`Nightingale history-alert result exceeds N9E_MAX_PAGES=${pageLimit}`)
  }
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  N9eApi,
  positiveInteger,
  unixSeconds
}

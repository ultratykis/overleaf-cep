import logger from '@overleaf/logger'
import OError from '@overleaf/o-error'
import {
  fetchNothing,
  fetchJson,
  fetchStringWithResponse,
  RequestFailedError,
} from '@overleaf/fetch-utils'
import { User } from '../../../../app/src/models/User.mjs'
import {
   NotFoundError,
   TooManyRequestsError,
   ServiceNotConfiguredError,
   ForbiddenError,
} from '../../../../app/src/Features/Errors/Errors.js'
import TokenManager from './TokenManager.mjs'

const ZOTERO_API_URL = 'https://api.zotero.org'
const REQUEST_TIMEOUT_MS = 60 * 1000
const SEARCH_RESULT_LIMIT = 5
// TODO: implement conditional requests

async function isLinked(userId) {
  return (await TokenManager.getCredentials(userId)) != null
}

/**
 * Build a header for Zotero API request.
 */
function buildHeaders(apiKey, opts = {}) {
  const headers = {
    'Zotero-API-Version': '3',
    'Zotero-API-Key': apiKey,
    'User-Agent': 'Overleaf-CEP-Zotero',
    ...opts,
  }
  return headers
}

/**
 * Checks connection to Zotero by calling /keys/{key}.
 */
async function getConnectionStatus(userId) {
  const credentials = await TokenManager.getCredentials(userId)
  if (!credentials) return false

  const { apiKey } = credentials
  try {
    await fetchJson(`${ZOTERO_API_URL}/keys/${apiKey}`, {
      headers: buildHeaders(apiKey),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    return true
  } catch (err) {
    normalizeApiError(err, 'getConnectionStatus')
  }
}

/**
 * Get the list of groups for a user.
 */
async function getGroupsForUser(userId) {
  const credentials = await TokenManager.getCredentials(userId)
  if (!credentials) return null

  const { apiKey, zoteroUserId } = credentials
  try {
    const groups = await fetchJson(`${ZOTERO_API_URL}/users/${zoteroUserId}/groups`, {
      headers: buildHeaders(apiKey),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    })
    return groups.map(g => ({
      id: String(g.id),
      name: g.data?.name || `Group ${g.id}`,
    }))
  } catch (err) {
    normalizeApiError(err, 'getGroupsForUser')
  }
}

/**
 * Export a library as BibTeX / BibLaTeX.
 */
async function getLibraryBibtex(userId, groupId, format) {
  const credentials = await TokenManager.getCredentials(userId)
  if (!credentials) {
    throw new ServiceNotConfiguredError({
      message: 'RefProvider credentials missed',
      info: { userId, status: 400 }
    })
  }

  // Main library or group?
  let basePath
  if (groupId) basePath = `/groups/${groupId}/items`
  else basePath = `/users/${credentials.zoteroUserId}/items`

  return _fetchBibtex(credentials.apiKey, basePath, format)
}

/**
 * Fetch all items from a Zotero library endpoint as BibTeX.
 * Handles pagination (Zotero API limits to 100 items per request).
 */
async function _fetchBibtex(apiKey, basePath, format) {
  const limit = 100
  let allBibtex = ''

  try {
    let start = 0
    const headers = buildHeaders(apiKey)
    while (true) {
      const url = `${ZOTERO_API_URL}${basePath}?format=${format}&limit=${limit}&start=${start}`
      const { body: bibtex, response } = await fetchStringWithResponse(url, {
        headers,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      })

      if (bibtex.trim()) allBibtex += bibtex

      const totalResults = parseInt(response.headers.get('Total-Results') || '0', 10)
      start += limit
      if (start >= totalResults) {
        break
      }
    }
  } catch (err) {
    normalizeApiError(err, '_fetchBibtex')
  }
  return allBibtex
}

function boundedText(value, limit) {
  return typeof value === 'string' ? value.trim().slice(0, limit) : ''
}

function normalizeSearchItem(item) {
  const data = item?.data
  const itemKey = boundedText(item?.key || data?.key, 100)
  const itemType = boundedText(data?.itemType, 100)
  if (
    !itemKey ||
    !itemType ||
    ['attachment', 'note', 'annotation'].includes(itemType)
  ) {
    return null
  }

  const creators = Array.isArray(data.creators)
    ? data.creators.slice(0, 20).map(creator => ({
        firstName: boundedText(creator?.firstName, 200),
        lastName: boundedText(creator?.lastName || creator?.name, 200),
        creatorType: boundedText(creator?.creatorType, 100),
      }))
    : []
  const date = boundedText(data.date, 100)

  return Object.freeze({
    itemKey,
    itemType,
    title: boundedText(data.title, 2000),
    creators: Object.freeze(creators),
    year: date.match(/\b\d{4}\b/u)?.[0] || null,
    doi: boundedText(data.DOI, 300) || null,
    verificationDepth: 'metadata-only',
  })
}

/**
 * Search the authenticated user's personal library without exposing the key.
 */
async function searchItems(userId, { query, signal } = {}) {
  if (
    typeof query !== 'string' ||
    query.trim().length === 0 ||
    query.trim().length > 200
  ) {
    throw new TypeError('Zotero search query must be 1 to 200 characters')
  }
  const normalizedQuery = query.trim()
  const credentials = await TokenManager.getCredentials(userId)
  if (!credentials) return null

  const url = new URL(
    `${ZOTERO_API_URL}/users/${credentials.zoteroUserId}/items/top`
  )
  url.searchParams.set('format', 'json')
  url.searchParams.set('include', 'data')
  url.searchParams.set('itemType', '-attachment')
  url.searchParams.set('q', normalizedQuery)
  url.searchParams.set('qmode', 'titleCreatorYear')
  url.searchParams.set('limit', String(SEARCH_RESULT_LIMIT))

  try {
    const items = await fetchJson(url.toString(), {
      headers: buildHeaders(credentials.apiKey),
      signal: signal || AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (!Array.isArray(items)) return []
    return Object.freeze(
      items
        .slice(0, SEARCH_RESULT_LIMIT)
        .map(normalizeSearchItem)
        .filter(item => item != null)
    )
  } catch (err) {
    normalizeApiError(err, 'searchItems')
  }
}

/**
 * Unlink a Zotero account.
 */
async function unlinkAccount(userId) {
  const credentials = await TokenManager.getCredentials(userId)
  if (!credentials) return

  await User.updateOne(
    { _id: userId },
    { $unset: { 'refProviders.zotero': 1 } }
  ).exec()

  try {
    const { apiKey } = credentials
    await fetchNothing(`${ZOTERO_API_URL}/keys/${apiKey}`, {
      method: 'DELETE',
      headers: buildHeaders(apiKey),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (err) {
     logger.error({ err }, 'failed to detete key from Zotero account')
  }

}

function normalizeApiError(err, operation) {
  logger.error({ operation }, 'Zotero API request failed')

  if (err.name === 'AbortError') {
    throw new OError('RefProvider request timed out', { operation, status: 504 }).withCause(err)
  }

  if (!(err instanceof RequestFailedError)) {
    throw new OError('Something wrong with RefProvider request', { operation, status: 500 }).withCause(err)
  }

  const status = err.response?.status || 500

  if (status === 403) {
    throw new ForbiddenError({
       message: 'Access denied',
       info: { operation, status }
    }).withCause(err)
  }

  if (status === 404) {
    throw new NotFoundError({
       message: 'Not found',
       info: { operation, status }
    }).withCause(err)
  }

  if (status === 429) {
    throw new TooManyRequestsError({
      message: 'Rate limit exeeded',
      info: { operation, status }
    }).withCause(err)
  }

  throw new OError('RefProvider request error', { operation, status }).withCause(err)
}

export default {
  isLinked,
  getConnectionStatus,
  getGroupsForUser,
  getLibraryBibtex,
  searchItems,
  unlinkAccount,
}

// Catalpa 目录服务 HTTP API（零依赖，node:http）。
// 解析的是“已保存版本”，并维护公开链接迁移与节点沿革。

import http from 'node:http'
import { URL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { JsonStore } from './db.js'
import { parseHeadings } from '../src/core/parser.js'
import { reconcileHeadings, emptyState } from '../src/core/heading-diff.js'
import { buildIndex, resolveAnchor, freezeIndex } from '../src/core/index.js'
import { contentHash } from '../src/core/identity.js'

export async function createServer({ dbFile = './server/data/catalpa.json' } = {}) {
  const store = new JsonStore(dbFile)
  await store.init()

  const getDoc = (data, id) => data.documents.get(id)
  const stateOf = (data, id) => ({ revision: data.documents.get(id)?.revision ?? 0, nodes: data.nodes.get(id) ?? [] })

  function publicView(data, doc) {
    const nodes = data.nodes.get(doc.id) ?? []
    const live = nodes.filter((n) => n.status === 'live')
    return {
      id: doc.id,
      slug: doc.slug,
      title: doc.title,
      revision: doc.revision,
      contentHash: doc.contentHash,
      updatedAt: doc.updatedAt,
      source: doc.source,
      liveNodes: live.map(indexNodeView),
    }
  }

  function indexNodeView(n) {
    return {
      id: n.id,
      level: n.level,
      text: n.text,
      line: n.line,
      endLine: n.endLine,
      slug: n.slug,
      explicitId: n.explicitId,
      aliases: n.aliases,
      status: n.status,
    }
  }

  const routes = {
    // 创建文档
    'POST /api/docs': async (req, data) => {
      const body = await readJson(req)
      const id = body.id || `doc_${randomUUID().slice(0, 8)}`
      if (data.documents.has(id)) throw httpError(409, 'document exists')
      const source = body.source ?? ''
      const state = reconcileHeadings(emptyState(), parseHeadings(source), { revision: 1, now: Date.now() })
      data.documents.set(id, {
        id,
        slug: body.slug || id,
        title: body.title || 'Untitled',
        revision: 1,
        source,
        contentHash: contentHash(source),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      data.revisions.set(id, [{ revision: 1, source, contentHash: contentHash(source), createdAt: new Date().toISOString(), nodes: state.nodes }])
      data.nodes.set(id, state.nodes)
      data.events.set(id, state.events)
      data.links.set(id, [])
      data.exports.set(id, [])
      return { status: 201, body: publicView(data, data.documents.get(id)) }
    },

    // 读取文档（当前保存版本 + 索引视图）
    'GET /api/docs/:id': async (req, data, params) => {
      const doc = getDoc(data, params.id)
      if (!doc) throw httpError(404, 'not found')
      return { status: 200, body: publicView(data, doc) }
    },

    // 节点沿革（含已删除）与事件
    'GET /api/docs/:id/history': async (req, data, params) => {
      if (!getDoc(data, params.id)) throw httpError(404, 'not found')
      return {
        status: 200,
        body: {
          revision: getDoc(data, params.id).revision,
          nodes: data.nodes.get(params.id) ?? [],
          events: data.events.get(params.id) ?? [],
        },
      }
    },

    // 保存新版本（CAS：baseRevision 必须等于服务器当前版本）
    'PUT /api/docs/:id': async (req, data, params) => {
      const doc = getDoc(data, params.id)
      if (!doc) throw httpError(404, 'not found')
      const body = await readJson(req)
      const base = Number(body.baseRevision ?? -1)
      if (base !== doc.revision) {
        // 409：返回服务器最新内容与节点沿革，供客户端按位置映射协议处理
        const serverState = stateOf(data, params.id)
        const theirs = reconcileHeadings(serverState, parseHeadings(body.source ?? ''), {
          revision: doc.revision + 1,
          now: Date.now(),
        })
        return {
          status: 409,
          body: {
            error: 'revision-conflict',
            current: publicView(data, doc),
            serverHistory: { nodes: data.nodes.get(params.id) ?? [], events: data.events.get(params.id) ?? [] },
            tentativeReconcile: { events: theirs.events, warnings: theirs.warnings },
          },
        }
      }
      const source = body.source ?? ''
      const revision = doc.revision + 1
      const prevState = stateOf(data, params.id)
      const state = reconcileHeadings(prevState, parseHeadings(source), { revision, now: Date.now() })
      doc.source = source
      doc.revision = revision
      doc.contentHash = contentHash(source)
      doc.title = body.title ?? doc.title
      doc.updatedAt = new Date().toISOString()
      data.nodes.set(params.id, state.nodes)
      data.events.set(params.id, [...(data.events.get(params.id) ?? []), ...state.events])
      data.revisions.get(params.id).push({
        revision,
        source,
        contentHash: doc.contentHash,
        createdAt: doc.updatedAt,
        nodes: state.nodes,
      })
      // 迁移公开链接解析状态
      const index = buildIndex(state, { docId: params.id, revision, source })
      for (const link of data.links.get(params.id) ?? []) {
        const r = resolveAnchor(index, link.anchor)
        link.lastResolution = r.status
        link.nodeId = r.nodeId ?? link.nodeId ?? null
        link.candidates = r.candidates ?? null
        link.updatedRevision = revision
        link.history.push({ revision, status: r.status, at: doc.updatedAt })
      }
      return { status: 200, body: { ...publicView(data, doc), warnings: state.warnings, events: state.events } }
    },

    // 仅解析锚点（当前索引）
    'GET /api/docs/:id/resolve': async (req, data, params, url) => {
      const doc = getDoc(data, params.id)
      if (!doc) throw httpError(404, 'not found')
      const anchor = url.searchParams.get('anchor') ?? ''
      const state = stateOf(data, params.id)
      const index = buildIndex(state, { docId: params.id, revision: doc.revision, source: doc.source })
      const result = resolveAnchor(index, anchor)
      const node = result.nodeId ? state.nodes.find((n) => n.id === result.nodeId) : null
      return { status: 200, body: { ...result, node: node ? indexNodeView(node) : null } }
    },

    // 创建公开链接（绑定稳定 id 或可读别名；记录后续迁移）
    'POST /api/docs/:id/links': async (req, data, params) => {
      const doc = getDoc(data, params.id)
      if (!doc) throw httpError(404, 'not found')
      const body = await readJson(req)
      const links = data.links.get(params.id)
      const link = {
        id: randomUUID().slice(0, 8),
        slug: body.slug || `l${links.length + 1}`,
        anchor: body.anchor,
        nodeId: null,
        lastResolution: null,
        candidates: null,
        createdAtRevision: doc.revision,
        updatedRevision: doc.revision,
        history: [],
      }
      links.push(link)
      const index = buildIndex(stateOf(data, params.id), { docId: params.id, revision: doc.revision })
      const r = resolveAnchor(index, body.anchor)
      link.lastResolution = r.status
      link.nodeId = r.nodeId ?? null
      link.candidates = r.candidates ?? null
      link.history.push({ revision: doc.revision, status: r.status, at: new Date().toISOString() })
      return { status: 201, body: link }
    },

    'GET /api/docs/:id/links': async (req, data, params) => {
      if (!getDoc(data, params.id)) throw httpError(404, 'not found')
      return { status: 200, body: { links: data.links.get(params.id) ?? [] } }
    },

    // 公开访问：/l/:docSlug/:linkSlug 或 /l/:docSlug/:linkSlug?rev=
    'GET /l/:docSlug/:linkSlug': async (req, data, params) => {
      const doc = [...data.documents.values()].find((d) => d.slug === params.docSlug)
      if (!doc) throw httpError(404, 'document not found')
      const link = (data.links.get(doc.id) ?? []).find((l) => l.slug === params.linkSlug)
      if (!link) throw httpError(404, 'link not found')
      const url = new URL(req.url, 'http://x')
      const exportId = url.searchParams.get('export')
      let index
      if (exportId) {
        const stored = (data.exports.get(doc.id) ?? []).find((e) => e.exportId === exportId)
        if (!stored) throw httpError(404, 'export not found')
        index = rehydrateFrozen(stored).index
      } else {
        index = buildIndex(stateOf(data, doc.id), { docId: doc.id, revision: doc.revision })
      }
      const result = resolveAnchor(index, link.anchor)
      return {
        status: 200,
        body: {
          link: link.slug,
          anchor: link.anchor,
          resolution: result,
          exported: Boolean(exportId),
          node: result.nodeId
            ? indexNodeView(index.nodes.get(result.nodeId))
            : null,
        },
      }
    },

    // 创建冻结导出（默认当前版本）
    'POST /api/docs/:id/exports': async (req, data, params) => {
      const doc = getDoc(data, params.id)
      if (!doc) throw httpError(404, 'not found')
      const body = await readJson(req).catch(() => ({}))
      const atRevision = Number(body.revision ?? doc.revision)
      const history = data.revisions.get(params.id) ?? []
      const saved = history.find((h) => h.revision === atRevision)
      if (!saved || !saved.nodes) throw httpError(400, `no frozen node snapshot for revision ${atRevision}`)
      // 直接使用该保存版本留存的节点快照（历史事实），不做重新推演。
      const replay = { revision: atRevision, nodes: saved.nodes }
      const liveIndex = buildIndex(replay, { docId: params.id, revision: atRevision, source: saved.source })
      const exportId = `exp_${randomUUID().slice(0, 8)}`
      const frozen = {
        exportId,
        docId: params.id,
        revision: atRevision,
        source: saved.source,
        createdAt: new Date().toISOString(),
        index: freezeIndex(liveIndex, { exportId }),
      }
      const list = data.exports.get(params.id)
      list.push(stripFrozenForStorage(frozen))
      return { status: 201, body: { exportId, revision: atRevision, docId: params.id } }
    },

    'GET /api/docs/:id/exports': async (req, data, params) => {
      if (!getDoc(data, params.id)) throw httpError(404, 'not found')
      const list = (data.exports.get(params.id) ?? []).map(({ index, ...rest }) => ({
        ...rest,
        liveIds: index.liveIds,
      }))
      return { status: 200, body: { exports: list } }
    },

    // 冻结链接解析：/p/:docSlug/:exportId#anchor
    'GET /p/:docSlug/:exportId': async (req, data, params, url) => {
      const doc = [...data.documents.values()].find((d) => d.slug === params.docSlug)
      if (!doc) throw httpError(404, 'document not found')
      const frozen = rehydrateFrozen((data.exports.get(doc.id) ?? []).find((e) => e.exportId === params.exportId))
      if (!frozen) throw httpError(404, 'export not found')
      const anchor = url.searchParams.get('anchor') ?? (req.rawHash ?? '').replace(/^#/, '')
      const result = anchor ? resolveAnchor(frozen.index, anchor) : { status: 'ok', nodeId: null }
      return {
        status: 200,
        body: {
          exportId: frozen.exportId,
          revision: frozen.revision,
          anchor,
          resolution: result,
          node: result.nodeId ? indexNodeView(frozen.index.nodes.get(result.nodeId)) : null,
        },
      }
    },
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost')
      const { handler, params } = matchRoute(req.method, url.pathname, routes)
      if (!handler) return send(res, 404, { error: 'no route' })
      const respond = (entry) => send(res, entry.status, entry.body)
      const isWrite = req.method === 'POST' || req.method === 'PUT'
      if (isWrite) {
        const entry = await store.tx((data) => handler(req, data, params, url))
        respond(entry)
      } else {
        const entry = store.read((data) => handler(req, data, params, url))
        respond(await entry)
      }
    } catch (err) {
      const code = err.statusCode || 500
      send(res, code, { error: err.message || 'server error' })
    }
  })

  server.store = store
  server.routes = routes
  return server
}

// 冻结索引含 Map，落盘前转成数组；读取时还原。
function stripFrozenForStorage(frozen) {
  const mapsToArrays = (index) => ({
    ...index,
    aliasToNode: [...index.aliasToNode],
    aliasOwners: [...index.aliasOwners],
    inheritedBy: [...index.inheritedBy],
    splitParents: [...index.splitParents],
    nodes: [...index.nodes],
  })
  return { ...frozen, index: mapsToArrays(frozen.index) }
}

// 磁盘数组 -> 运行时 Map（冻结索引）。
function rehydrateFrozen(frozen) {
  const toMap = (entries) => new Map(entries ?? [])
  return {
    ...frozen,
    index: {
      ...frozen.index,
      aliasToNode: toMap(frozen.index.aliasToNode),
      aliasOwners: toMap(frozen.index.aliasOwners),
      inheritedBy: toMap(frozen.index.inheritedBy),
      splitParents: toMap(frozen.index.splitParents),
      nodes: toMap(frozen.index.nodes),
    },
  }
}

function matchRoute(method, pathname, routes) {
  for (const key of Object.keys(routes)) {
    const [m, pattern] = key.split(' ')
    if (m !== method) continue
    const names = []
    const re = new RegExp(`^${pattern.replace(/:[^/]+/g, (x) => {
      names.push(x.slice(1))
      return '([^/]+)'
    })}$`)
    const m2 = pathname.match(re)
    if (m2) {
      const params = Object.fromEntries(names.map((n, i) => [n, decodeURIComponent(m2[i + 1])]))
      return { handler: routes[key], params }
    }
  }
  return {}
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.on('data', (c) => {
      raw += c
      if (raw.length > 5e6) reject(httpError(413, 'payload too large'))
    })
    req.on('end', () => {
      if (!raw) return resolve({})
      try {
        resolve(JSON.parse(raw))
      } catch {
        reject(httpError(400, 'invalid json'))
      }
    })
    req.on('error', reject)
  })
}

function send(res, code, body) {
  const json = JSON.stringify(body)
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' })
  res.end(json)
}

function httpError(statusCode, message) {
  const err = new Error(message)
  err.statusCode = statusCode
  return err
}

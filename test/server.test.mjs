import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from '../server/app.js'
import { rm } from 'node:fs/promises'

const DB = './server/data/test-server.json'
let base
let server

before(async () => {
  await rm(DB, { force: true })
  server = await createServer({ dbFile: DB })
  await new Promise((resolve) => server.listen(0, resolve))
  base = `http://127.0.0.1:${server.address().port}`
})

after(async () => {
  await new Promise((resolve) => server.close(resolve))
  await rm(DB, { force: true })
})

const call = async (method, pathname, body) => {
  const res = await fetch(`${base}${pathname}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  const json = await res.json()
  return { status: res.status, json }
}

test('创建文档 => 服务器解析保存版并生成锚点索引', async () => {
  const { status, json } = await call('POST', '/api/docs', {
    id: 'doc1',
    slug: 'doc1',
    source: '# Alpha\n\n# Beta\n',
  })
  assert.equal(status, 201)
  assert.equal(json.revision, 1)
  assert.equal(json.liveNodes.length, 2)
  assert.equal(json.liveNodes[0].slug, 'alpha')
})

test('保存新版本：改名保持节点 id；解析旧 slug 返回 renamed', async () => {
  const before = await call('GET', '/api/docs/doc1')
  const alphaId = before.json.liveNodes.find((n) => n.text === 'Alpha').id

  const saved = await call('PUT', '/api/docs/doc1', {
    baseRevision: 1,
    source: '# Alpha Renamed\n\n# Beta\n',
  })
  assert.equal(saved.status, 200)
  assert.equal(saved.json.revision, 2)
  const renamed = saved.json.liveNodes.find((n) => n.text === 'Alpha Renamed')
  assert.equal(renamed.id, alphaId)

  const resolved = await call('GET', '/api/docs/doc1/resolve?anchor=alpha')
  assert.equal(resolved.json.status, 'renamed')
  assert.equal(resolved.json.nodeId, alphaId)
})

test('跨设备同时改层级：过期 baseRevision 返回 409，含服务器沿革', async () => {
  // 另一设备先保存 v3：Beta -> ### Beta（改层级）
  const a = await call('PUT', '/api/docs/doc1', { baseRevision: 2, source: '# Alpha Renamed\n\n### Beta\n' })
  assert.equal(a.status, 200)
  assert.equal(a.json.revision, 3)

  // 本设备仍基于 v2 保存 => 冲突
  const stale = await call('PUT', '/api/docs/doc1', {
    baseRevision: 2,
    source: '# Alpha Renamed\n\n## Beta Local\n',
  })
  assert.equal(stale.status, 409)
  assert.equal(stale.json.error, 'revision-conflict')
  assert.equal(stale.json.current.revision, 3)
  assert.ok(Array.isArray(stale.json.tentativeReconcile.events))
  // 服务器沿革中记录了 level-change
  const history = await call('GET', '/api/docs/doc1/history')
  assert.ok(history.json.events.some((e) => e.type === 'level-change'))
})

test('公开链接：改名后迁移；拆分后歧义不自动跳；同名无关 foreign', async () => {
  const d = await call('POST', '/api/docs', { id: 'doc2', slug: 'doc2', source: '# Keep\n\n# Target\n\n# Tail\n' })
  const targetId = d.json.liveNodes.find((n) => n.text === 'Target').id

  const link = await call('POST', '/api/docs/doc2/links', { slug: 'target-link', anchor: targetId })
  assert.equal(link.status, 201)
  assert.equal(link.json.lastResolution, 'ok')

  // 改名
  await call('PUT', '/api/docs/doc2', { baseRevision: 1, source: '# Keep\n\n# Target New\n\n# Tail\n' })
  const migrated = await call('GET', '/l/doc2/target-link')
  assert.equal(migrated.json.resolution.status, 'ok')
  assert.equal(migrated.json.node.id, targetId)

  // 删除并以不同上下文新建同名节 => foreign
  await call('PUT', '/api/docs/doc2', { baseRevision: 2, source: '# Keep\n\n# Tail\n' })
  await call('PUT', '/api/docs/doc2', { baseRevision: 3, source: '# Other\n\n# Target New\n' })
  const foreign = await call('GET', '/l/doc2/target-link')
  assert.equal(foreign.json.resolution.status, 'foreign')
  assert.notEqual(foreign.json.resolution.currentNodeId, targetId)
})

test('拆分公开链接：返回 ambiguous 候选，不重定向', async () => {
  const d = await call('POST', '/api/docs', { id: 'doc3', slug: 'doc3', source: '# Intro\n\n# Mono\n' })
  const monoId = d.json.liveNodes.find((n) => n.text === 'Mono').id
  await call('POST', '/api/docs/doc3/links', { slug: 'mono', anchor: monoId })
  await call('PUT', '/api/docs/doc3', { baseRevision: 1, source: '# Intro\n\n# Mono One\n\n# Mono Two\n' })
  const r = await call('GET', '/l/doc3/mono')
  assert.equal(r.json.resolution.status, 'ambiguous')
  assert.equal(r.json.resolution.candidates.length, 2)
})

test('冻结导出：后续变更不影响导出锚点', async () => {
  const d = await call('POST', '/api/docs', { id: 'doc4', slug: 'doc4', source: '# Intro\n\n# Frozen Sec\n' })
  const fid = d.json.liveNodes.find((n) => n.text === 'Frozen Sec').id
  const exp = await call('POST', '/api/docs/doc4/exports', {})
  assert.equal(exp.status, 201)
  const exportId = exp.json.exportId

  // live 改名
  await call('PUT', '/api/docs/doc4', { baseRevision: 1, source: '# Intro\n\n# Completely Different\n' })
  // 冻结链接仍解析到原节点
  const frozen = await call('GET', `/p/doc4/${exportId}?anchor=${encodeURIComponent(fid)}`)
  assert.equal(frozen.json.resolution.status, 'ok')
  assert.equal(frozen.json.node.text, 'Frozen Sec')

  // live 解析该 id 已经不是同一标题
  const live = await call('GET', `/api/docs/doc4/resolve?anchor=${encodeURIComponent(fid)}`)
  assert.equal(live.json.node.text, 'Completely Different')
})

test('导出指定旧版本：冻结的是该历史版本而非当前', async () => {
  const setup = await call('POST', '/api/docs', { id: 'doc5', slug: 'doc5', source: '# V1 Title\n' })
  const v1Id = setup.json.liveNodes[0].id
  await call('PUT', '/api/docs/doc5', { baseRevision: 1, source: '# V2 Title\n' })
  const exp = await call('POST', '/api/docs/doc5/exports', { revision: 1 })
  assert.equal(exp.json.revision, 1)
  const r = await call('GET', `/p/doc5/${exp.json.exportId}?anchor=${encodeURIComponent(v1Id)}`)
  assert.equal(r.json.resolution.status, 'ok')
  assert.equal(r.json.node.text, 'V1 Title')
  assert.equal(r.json.revision, 1)
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeHarness } from './helpers.mjs'
import { resolveAnchor } from '../src/core/index.js'

test('改名不改变身份，旧 slug 跟随（renamed）', () => {
  const h = makeHarness('rename')
  h.rev('# Overview\n\nbody\n')
  const id = h.find('Overview').id
  h.rev('# Overview v2\n\nbody\n')
  assert.equal(h.find('Overview v2').id, id)
  const idx = h.index()
  assert.equal(resolveAnchor(idx, id).status, 'ok')
  const oldSlug = resolveAnchor(idx, 'overview')
  assert.equal(oldSlug.status, 'renamed')
  assert.equal(oldSlug.nodeId, id)
})

test('改层级不改变身份，记录 level-change', () => {
  const h = makeHarness('level')
  h.rev('# Title\n')
  const id = h.find('Title').id
  h.rev('## Title\n')
  assert.equal(h.find('Title').id, id)
  assert.ok(h.events('level-change').some((e) => e.id === id && e.from === 1 && e.to === 2))
})

test('重复标题：三个不同身份，裸别名归首个', () => {
  const h = makeHarness('dup')
  h.rev('# Topic\n\n# Topic\n\n# Topic\n')
  const nodes = h.findAll('Topic')
  assert.equal(new Set(nodes.map((n) => n.id)).size, 3)
  assert.equal(nodes[0].slug, 'topic')
  assert.equal(nodes[1].slug, 'topic-2')
  assert.equal(nodes[2].slug, 'topic-3')
  const idx = h.index()
  // id 直达各自节点
  for (const n of nodes) assert.equal(resolveAnchor(idx, n.id).nodeId, n.id)
  // 裸别名只解到第一个
  assert.equal(resolveAnchor(idx, 'topic').nodeId, nodes[0].id)
})

test('拆分标题：旧锚点一对多歧义，不自动跳', () => {
  const h = makeHarness('split')
  h.rev('# Intro\n\n# Big\n')
  const big = h.find('Big').id
  h.rev('# Intro\n\n# Big North\n\n# Big South\n')
  const idx = h.index()
  const r = resolveAnchor(idx, big)
  assert.equal(r.status, 'ambiguous')
  assert.equal(r.candidates.length, 2)
  assert.ok(!('nodeId' in r) || r.nodeId == null)
  // 旧 slug 同样歧义
  const rs = resolveAnchor(idx, 'big')
  assert.equal(rs.status, 'ambiguous')
})

test('复制章节：新身份 + copy 事件，旧链接不落到复制品', () => {
  const h = makeHarness('copy')
  h.rev('# Intro\n\n# Section X\n\n# End\n')
  const original = h.find('Section X').id
  h.rev('# Intro\n\n# Section X\n\n# Section X\n\n# End\n')
  const nodes = h.findAll('Section X')
  assert.equal(nodes.length, 2)
  assert.equal(nodes[0].id, original)
  assert.notEqual(nodes[1].id, original)
  assert.equal(nodes[1].copiedFrom, original)
  const copyEvent = h.events('copy').find((e) => e.fromId === original)
  assert.ok(copyEvent)
  assert.equal(copyEvent.id, nodes[1].id)
  // 源节链接不跳复制品
  const idx = h.index()
  assert.equal(resolveAnchor(idx, original).nodeId, original)
})

test('删除后恢复：沿用原 id 与别名，链接重新有效', () => {
  const h = makeHarness('restore')
  h.rev('# Keep\n\n# Gone\n\n# Tail\n')
  const gone = h.find('Gone').id
  h.rev('# Keep\n\n# Tail\n')
  assert.equal(h.deleted.some((n) => n.id === gone), true)
  h.rev('# Keep\n\n# Gone\n\n# Tail\n')
  const back = h.find('Gone')
  assert.equal(back.id, gone)
  assert.equal(back.revivedFrom, gone)
  assert.ok(back.aliases.includes('gone'))
  const idx = h.index()
  assert.equal(resolveAnchor(idx, gone).status, 'ok')
})

test('同名无关章节：旧链接 foreign，绝不自动跳', () => {
  const h = makeHarness('foreign')
  h.rev('# Keep\n\n# Same\n\n# Tail\n')
  const oldId = h.find('Same').id
  h.rev('# Keep\n\n# Tail\n')
  h.rev('# Other\n\n# Same\n')
  const fresh = h.find('Same')
  assert.notEqual(fresh.id, oldId)
  const idx = h.index()
  const r = resolveAnchor(idx, 'same')
  assert.equal(r.status, 'foreign')
  assert.equal(r.currentNodeId, fresh.id)
  assert.notEqual(r.currentNodeId, oldId)
})

test('删除且无候选：gone', () => {
  const h = makeHarness('gone')
  h.rev('# A\n\n# Only\n')
  const id = h.find('Only').id
  h.rev('# A\n')
  const idx = h.index()
  assert.equal(resolveAnchor(idx, id).status, 'gone')
})

test('显式锚点：改名后稳定，重复显式锚点视为复制并消解冲突', () => {
  const h = makeHarness('explicit')
  h.rev('# Intro\n\n# Contact {#contact}\n')
  const id = h.find('Contact').id
  h.rev('# Intro\n\n# Contact Us {#contact}\n')
  assert.equal(h.find('Contact Us').id, id)
  const idx = h.index()
  assert.equal(resolveAnchor(idx, 'contact').nodeId, id)

  h.rev('# Intro\n\n# Contact Us {#contact}\n\n# Contact Us {#contact}\n')
  const nodes = h.findAll('Contact Us')
  assert.equal(nodes.length, 2)
  assert.notEqual(nodes[0].id, nodes[1].id)
  const explicitIds = nodes.map((n) => n.explicitId)
  assert.equal(new Set(explicitIds).size, 2)
  assert.ok(explicitIds.some((x) => /^contact-\d+$/.test(x)))
})

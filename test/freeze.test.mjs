import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeHarness } from './helpers.mjs'
import { buildIndex, freezeIndex, resolveAnchor, frozenHref } from '../src/core/index.js'

test('冻结导出：导出后大改 live，冻结链接仍按冻结索引解析', () => {
  const h = makeHarness('freeze')
  h.rev('# Intro\n\n# Spec\n\n# Tail\n')
  const specId = h.find('Spec').id
  const frozen = freezeIndex(h.index(1), { exportId: 'exp_1' })

  // 导出后：改名、拆分、删除
  h.rev('# Intro\n\n# Spec Renewed\n\n# Tail\n')
  h.rev('# Intro\n\n# Spec A\n\n# Spec B\n\n# Tail\n')
  h.rev('# Intro\n\n# Tail\n')
  const liveIndex = h.index()
  // live 中该节已历经改名+拆分+删除，无法自动定位
  assert.ok(['gone', 'ambiguous'].includes(resolveAnchor(liveIndex, specId).status))

  // 冻结快照仍然定位到 v1 的 Spec
  const r = resolveAnchor(frozen, specId)
  assert.equal(r.status, 'ok')
  assert.equal(r.nodeId, specId)

  // 冻结 href 形式
  const href = frozenHref('doc', 'exp_1', specId)
  assert.match(href, /^\/p\/doc\/exp_1#/)
})

test('冻结快照不可变：后续修改不影响已导出索引', () => {
  const h = makeHarness('immut')
  h.rev('# Stable\n')
  const frozen = freezeIndex(h.index(1), { exportId: 'exp_x' })
  h.rev('# Stable Changed\n')
  const again = h.index()
  assert.equal(frozen.revision, 1)
  assert.equal(frozen.nodes.get([...frozen.liveIds][0]).text, 'Stable')
  assert.notEqual(again, frozen)
})

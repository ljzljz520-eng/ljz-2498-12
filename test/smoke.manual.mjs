import assert from 'node:assert/strict'
import { parseHeadings } from '../src/core/parser.js'
import { reconcileHeadings, emptyState } from '../src/core/heading-diff.js'
import { buildIndex, resolveAnchor } from '../src/core/index.js'

let idc = 0
const idFactory = () => `id${++idc}`
let state = emptyState()
const rev = (src, revision) => reconcileHeadings(state, parseHeadings(src), { revision, idFactory, now: revision * 1000 })

// 初始：两个标题
state = rev('# A\n\ntext\n\n# B\n', 1)
const idA = state.live.find((n) => n.text === 'A').id
const idB = state.live.find((n) => n.text === 'B').id
assert.equal(state.live.length, 2)

// 改名 A -> A2，身份不变
state = rev('# A2\n\ntext\n\n# B\n', 2)
assert.equal(state.live.find((n) => n.text === 'A2').id, idA, 'rename keeps id')

// 重复标题：B 出现 3 次 -> 三个不同 id
state = rev('# A2\n\n# B\n\n# B\n\n# B\n', 3)
const bs = state.live.filter((n) => n.text === 'B')
assert.equal(new Set(bs.map((b) => b.id)).size, 3)
assert.equal(state.live.find((n) => n.text === 'A2').id, idA)

// 删除后恢复（结构证据：A2 仍在，恢复 B 第一节）
state = rev('# A2\n', 4)
assert.equal(state.deleted.length, 3)
state = rev('# A2\n\n# B\n', 5)
const restored = state.live.find((n) => n.text === 'B')
assert.ok(restored, 'B restored')
assert.equal(restored.revivedFrom, idB, 'restore keeps original id')
assert.equal(restored.id, idB)

// 拆分：B -> B-a / B-b，旧 id 歧义
state = rev('# A2\n\n# B-a\n\n# B-b\n', 6)
const idx = buildIndex(state, { revision: 6 })
const r = resolveAnchor(idx, idB)
assert.equal(r.status, 'ambiguous', 'split anchor ambiguous')
assert.equal(r.candidates.length, 2)

// 同名无关（拆分后）：候选也删除、再出现同名节 => 不自动跳、不定位到新节
state = rev('# A2\n', 7)
state = rev('# C\n\n# B\n', 8)
const idx8 = buildIndex(state, { revision: 8 })
const rOldB = resolveAnchor(idx8, 'b') // B 的旧 slug
assert.ok(['foreign', 'gone', 'ambiguous'].includes(rOldB.status), `unrelated same-title must not jump: ${rOldB.status}`)
assert.notEqual(rOldB.nodeId, idB)
if (rOldB.status === 'ambiguous') {
  assert.ok(!rOldB.candidates.includes(state.live.find((n) => n.text === 'B' && n.text !== 'C').id))
}

// 同名无关（无拆分，干净路径）：删除 D，再以不同上下文重建 D => foreign
let s = emptyState()
let sc = 0
const sf = (src, r) => reconcileHeadings(s, parseHeadings(src), { revision: r, now: r * 1000, idFactory: () => `s${++sc}` })
s = sf('# Keep\n\n# D\n\n# Tail\n', 1)
const idD = s.live.find((n) => n.text === 'D').id
s = sf('# Keep\n\n# Tail\n', 2)
s = sf('# Other\n\n# D\n', 3)
const idxD = buildIndex(s, { revision: 3 })
const rD = resolveAnchor(idxD, 'd')
assert.equal(rD.status, 'foreign', `same-title unrelated chapter: ${rD.status}`)
assert.notEqual(rD.currentNodeId, idD)

// 复制章节：在存活章节旁再粘贴一个同标题章节 => 新 id + copy 事件
let c = emptyState()
let cc = 0
const cf = (src, r) => reconcileHeadings(c, parseHeadings(src), { revision: r, now: r * 1000, idFactory: () => `c${++cc}` })
c = cf('# Intro\n\n# Copy Me\n\n# End\n', 1)
c = cf('# Intro\n\n# Copy Me\n\n# Copy Me\n\n# End\n', 2)
const cs = c.live.filter((n) => n.text === 'Copy Me')
assert.equal(cs.length, 2)
assert.notEqual(cs[0].id, cs[1].id)
assert.equal(cs[1].copiedFrom, cs[0].id)
// 旧链接按 id 直达源节，不会落到复制品
const idxCopy = buildIndex(c, { revision: 2 })
assert.equal(resolveAnchor(idxCopy, cs[0].id).nodeId, cs[0].id)

console.log('smoke ok')

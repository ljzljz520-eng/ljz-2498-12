import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildPositionMap, planNavigation } from '../src/core/position-map.js'
import { createVirtualWindow, clickToc } from '../src/core/virtual.js'
import { createTocSession, createAnchorMeasurement } from '../src/core/navigation-session.js'

const en = (id, line, extra = {}) => ({ id, line, ...extra })

test('三端版本一致 => synced，可双栏滚动', () => {
  const nodes = [en('a', 0), en('b', 4)]
  const map = buildPositionMap({
    editorRev: 3,
    previewRev: 3,
    indexRev: 3,
    editorNodes: nodes,
    previewNodes: nodes,
    indexNodes: nodes.map((n) => ({ ...n, anchor: n.id, alias: n.id })),
  })
  assert.equal(map.mappings.a.status, 'synced')
  const plan = planNavigation(map, 'a')
  assert.equal(plan.action, 'scroll-both')
})

test('预览/索引版本不一致 => index-stale，只提示待刷新不跳转', () => {
  const nodes = [en('a', 0)]
  const map = buildPositionMap({
    editorRev: 4,
    previewRev: 3,
    indexRev: 3,
    editorNodes: nodes,
    previewNodes: nodes,
    indexNodes: nodes,
  })
  const plan = planNavigation(map, 'a')
  assert.equal(plan.action, 'wait-refresh')
  assert.equal(plan.reason, 'index-stale')
})

test('未保存节点 => draft，仅编辑器定位', () => {
  const map = buildPositionMap({
    editorRev: 5,
    previewRev: 4,
    indexRev: 4,
    editorNodes: [en('draft1', 9)],
    previewNodes: [en('draft1', 9)],
    indexNodes: [],
  })
  const plan = planNavigation(map, 'draft1')
  assert.equal(plan.action, 'scroll-editor')
})

test('仅服务器有、编辑树无 => deleted，不跳转', () => {
  const map = buildPositionMap({
    editorRev: 5,
    previewRev: 5,
    indexRev: 5,
    editorNodes: [],
    previewNodes: [],
    indexNodes: [en('gone', 3)],
  })
  assert.equal(planNavigation(map, 'gone').action, 'show-deleted')
})

test('虚拟列表未加载节点：ensure-loaded 后重试成功，不乱跳', async () => {
  const total = 200
  const win = createVirtualWindow({ itemCount: total, overscan: 3 })
  win.setRange(0, 9) // 只加载前 ~12 个

  const ids = Array.from({ length: total }, (_, i) => `n${i}`)
  const previewRev = 1
  const build = (loadedSet) =>
    buildPositionMap({
      editorRev: 1,
      previewRev,
      indexRev: 1,
      editorNodes: ids.map((id, i) => en(id, i)),
      previewNodes: ids.map((id, i) => en(id, i, { loaded: loadedSet.has(i) })),
      indexNodes: ids.map((id, i) => en(id, i)),
    })

  let loaded = win.state.loaded
  let map = build(loaded)
  const targetId = 'n150'
  let firstPlan = planNavigation(map, targetId)
  assert.equal(firstPlan.action, 'ensure-loaded')

  const scrolled = []
  const result = await clickToc({
    map,
    nodeId: targetId,
    window: win,
    indexOf: (id) => ids.indexOf(id),
    rebuild: async () => build(win.state.loaded),
    scroll: async (plan) => scrolled.push(plan.target),
  })
  assert.equal(result.ok, true)
  assert.equal(result.plan.action, 'scroll-both')
  assert.deepEqual(scrolled, [targetId])
})

test('虚拟窗口无法加载（越界）=> 重试耗尽后 wait-refresh', async () => {
  const win = createVirtualWindow({ itemCount: 5, overscan: 1 })
  win.setRange(0, 2)
  const map = buildPositionMap({
    editorRev: 1,
    previewRev: 1,
    indexRev: 1,
    editorNodes: [],
    previewNodes: [],
    indexNodes: [en('x', 0)],
  })
  const result = await clickToc({
    map,
    nodeId: 'missing-node',
    window: win,
    indexOf: () => -1,
    rebuild: async () => map,
    scroll: async () => {},
  }, 1)
  assert.equal(result.ok, false)
  assert.equal(result.plan.action, 'wait-refresh')
})

test('导航会话：目录->编辑->返回预览仍定位同一身份', () => {
  const session = createTocSession()
  const map = buildPositionMap({
    editorRev: 2,
    previewRev: 2,
    indexRev: 2,
    editorNodes: [en('keep', 5)],
    previewNodes: [en('keep', 5)],
    indexNodes: [en('keep', 5)],
  })
  session.beginNavigation('keep')
  const back = session.resolveReturn(map)
  assert.equal(back.status, 'synced')
  assert.equal(back.anchor, 'keep')
  assert.equal(back.preview.line, 5)
})

test('返回预览时版本已变 => index-stale 提示而非旧坐标乱跳', () => {
  const session = createTocSession()
  session.beginNavigation('keep')
  const map = buildPositionMap({
    editorRev: 9,
    previewRev: 8,
    indexRev: 7,
    editorNodes: [en('keep', 5)],
    previewNodes: [en('keep', 5)],
    indexNodes: [en('keep', 5)],
  })
  assert.equal(session.resolveReturn(map).status, 'index-stale')
})

test('字体重排：缓存像素作废后按 id 重新测量', async () => {
  let tops = new Map([['a', 100]])
  const measurement = createAnchorMeasurement({
    measureEl: (el) => ({ top: tops.get(el.id), height: 20 }),
  })
  const first = await measurement.measure('a', { id: 'a' })
  assert.equal(first.top, 100)
  // 字体加载完成导致重排
  tops = new Map([['a', 340]])
  measurement.invalidate('fonts-ready')
  const second = await measurement.measure('a', { id: 'a' })
  assert.equal(second.top, 340)
  assert.equal(second.generation, first.generation + 1)
})

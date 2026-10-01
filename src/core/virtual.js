// 虚拟目录列表的窗口管理：未加载节点先滚入窗口再测量。
// 纯逻辑版（无 DOM），便于 Node 下验收；浏览器侧用同一 API 接入滚动容器。

export function createVirtualWindow({ itemCount = 0, overscan = 5 } = {}) {
  const state = {
    itemCount,
    overscan,
    start: 0,
    end: Math.min(itemCount - 1, -1),
    loaded: new Set(),
  }

  function setRange(visibleStart, visibleEnd) {
    state.start = Math.max(0, visibleStart - overscan)
    state.end = Math.min(itemCount - 1, visibleEnd + overscan)
    for (let i = state.start; i <= state.end; i++) state.loaded.add(i)
  }

  function isIndexLoaded(index) {
    return state.loaded.has(index)
  }

  // 请求某个索引可加载：若不在窗口则扩展窗口（模拟滚动），返回是否需要重试。
  function ensureIndex(index) {
    if (index < 0 || index >= itemCount) return { expanded: false, loaded: false }
    if (state.loaded.has(index)) return { expanded: false, loaded: true }
    state.start = Math.max(0, Math.min(state.start, index - overscan))
    state.end = Math.min(itemCount - 1, Math.max(state.end, index + overscan))
    for (let i = state.start; i <= state.end; i++) state.loaded.add(i)
    return { expanded: true, loaded: state.loaded.has(index) }
  }

  function setItemCount(n) {
    state.itemCount = n
    state.end = Math.min(state.end, n - 1)
  }

  return { state, setRange, isIndexLoaded, ensureIndex, setItemCount }
}

// 结合 PositionMap 的点击流程：缺映射 -> ensureVisible -> 重算后重试一次。
export async function clickToc({ map, nodeId, window: win, indexOf, rebuild, scroll }, retries = 1) {
  const { planNavigation } = await import('./position-map.js')
  let current = map
  for (let attempt = 0; attempt <= retries; attempt++) {
    const plan = planNavigation(current, nodeId)
    if (plan.action === 'ensure-loaded') {
      const idx = indexOf(nodeId)
      win.ensureIndex(idx)
      current = await rebuild()
      continue
    }
    if (plan.action === 'scroll-both' || plan.action === 'scroll-editor') {
      await scroll(plan)
      return { ok: true, plan }
    }
    return { ok: false, plan }
  }
  return { ok: false, plan: { action: 'wait-refresh', reason: 'retry-exhausted' } }
}

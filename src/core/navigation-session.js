// 目录导航会话：点击目录 -> 编辑位置 -> 返回预览仍定位同一内容。
// 记住的是节点身份而非像素坐标；字体重排后以身份重新测量。

export function createTocSession({ storage } = {}) {
  const mem = new Map()
  const store = {
    get(key) {
      if (storage) {
        try {
          const raw = storage.getItem(key)
          return raw == null ? undefined : JSON.parse(raw)
        } catch {
          return undefined
        }
      }
      return mem.has(key) ? mem.get(key) : undefined
    },
    set(key, value) {
      if (storage) storage.setItem(key, JSON.stringify(value))
      else mem.set(key, value)
    },
    del(key) {
      if (storage) storage.removeItem(key)
      else mem.delete(key)
    },
  }

  const KEY = 'catalpa.toc-session'

  return {
    beginNavigation(nodeId, { from = 'toc' } = {}) {
      store.set(KEY, { anchor: nodeId, from, at: Date.now() })
    },
    current() {
      return store.get(KEY) ?? null
    },
    // 返回预览：用当前 PositionMap 重新解析同一节点；失效则不给坐标（由 UI 提示）
    resolveReturn(map) {
      const session = store.get(KEY)
      if (!session) return null
      const m = map?.mappings?.[session.anchor]
      if (!m) return { anchor: session.anchor, status: 'missing' }
      if (m.status === 'synced' && m.preview?.loaded !== false) {
        return { anchor: session.anchor, status: 'synced', preview: m.preview }
      }
      if (m.status === 'deleted') return { anchor: session.anchor, status: 'deleted' }
      if (m.status === 'index-stale') return { anchor: session.anchor, status: 'index-stale' }
      return { anchor: session.anchor, status: 'missing' }
    },
    clear() {
      store.del(KEY)
    },
  }
}

// 字体重排 / 容器变化时，丢弃缓存像素，按 id 重新测量。
export function createAnchorMeasurement({ measureEl, onInvalidate } = {}) {
  let cache = new Map()
  let generation = 0

  const invalidate = (reason) => {
    generation += 1
    cache = new Map()
    onInvalidate?.(reason, generation)
  }

  if (typeof document !== 'undefined' && document.fonts?.ready) {
    document.fonts.ready.then(() => invalidate('fonts-ready')).catch(() => {})
  }

  function observe(container) {
    if (typeof ResizeObserver === 'undefined' || !container) return () => {}
    const ro = new ResizeObserver(() => invalidate('resize'))
    ro.observe(container)
    return () => ro.disconnect()
  }

  async function measure(id, el) {
    if (cache.has(id)) return { ...cache.get(id), generation, cached: true }
    const rect = measureEl ? measureEl(el) : el?.getBoundingClientRect?.()
    const pos = rect ? { top: rect.top, height: rect.height } : null
    if (pos) cache.set(id, pos)
    return { ...pos, generation, cached: false }
  }

  return { measure, invalidate, observe, get generation() { return generation } }
}

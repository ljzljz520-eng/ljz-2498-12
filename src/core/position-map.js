// 位置映射协议：合并编辑树 / 预览 / 服务器索引三个可能不同版本的位置信息。
// 缺少可信映射时返回 index-stale | missing | deleted，由 UI 显示“待刷新”，不跳转。

export function buildPositionMap({
  id,
  editorRev,
  previewRev,
  indexRev,
  editorNodes = [],
  previewNodes = [],
  indexNodes = [], // 服务器索引存活节点（含 id、line、alias）
} = {}) {
  const mappings = {}
  const ids = new Set([
    ...editorNodes.map((n) => n.id),
    ...previewNodes.map((n) => n.id),
    ...indexNodes.map((n) => n.id),
  ])

  const editorMap = new Map(editorNodes.map((n) => [n.id, n]))
  const previewMap = new Map(previewNodes.map((n) => [n.id, n]))
  const indexMap = new Map(indexNodes.map((n) => [n.id, n]))

  for (const nodeId of ids) {
    const e = editorMap.get(nodeId)
    const p = previewMap.get(nodeId)
    const x = indexMap.get(nodeId)
    let status = 'synced'

    if (e && !x) {
      status = 'draft' // 仅存在于编辑树，尚未保存
    } else if ((e || p) && !e) {
      status = 'index-stale'
    } else if (!e && !p && x) {
      status = 'deleted'
    } else {
      // 三方都有时，检查版本与加载状态
      const versions = [e && editorRev, p && previewRev, x && indexRev]
      const stale = (e && p && editorRev !== previewRev) || (p && x && previewRev !== indexRev)
      if (stale) {
        status = 'index-stale'
      } else if ((e && e.loaded === false) || (p && p.loaded === false)) {
        status = 'missing'
      } else {
        status = 'synced'
      }
      void versions
    }
    if (e && e.loaded === false && status === 'synced') status = 'missing'
    if (p && p.loaded === false && status === 'synced') status = 'missing'

    mappings[nodeId] = {
      id: nodeId,
      editor: e ? { line: e.line, offset: e.offset ?? 0, rev: editorRev, loaded: e.loaded !== false } : null,
      preview: p ? { line: p.line, offset: p.offset ?? 0, rev: previewRev, loaded: p.loaded !== false } : null,
      index: x ? { line: x.line, anchor: x.anchor ?? nodeId, alias: x.alias ?? null, rev: indexRev, loaded: true } : null,
      status,
    }
  }

  return { id: id ?? 'pmap', editorRev, previewRev, indexRev, mappings }
}

// 目录点击决策。返回动作；任何非可跳转状态都交给 UI 提示。
export function planNavigation(map, nodeId) {
  const m = map?.mappings?.[nodeId]
  if (!m) return { action: 'wait-refresh', reason: 'no-mapping' }
  switch (m.status) {
    case 'synced':
      return { action: 'scroll-both', target: nodeId, editor: m.editor, preview: m.preview }
    case 'draft':
      return { action: 'scroll-editor', target: nodeId, editor: m.editor, hint: 'draft-not-saved' }
    case 'missing':
      return { action: 'ensure-loaded', target: nodeId, retry: true }
    case 'index-stale':
      return {
        action: 'wait-refresh',
        target: nodeId,
        reason: 'index-stale',
        detail: { editorRev: map.editorRev, previewRev: map.previewRev, indexRev: map.indexRev },
      }
    case 'deleted':
      return { action: 'show-deleted', target: nodeId }
    default:
      return { action: 'wait-refresh', reason: 'unknown-status' }
  }
}

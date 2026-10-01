// 按“已保存版本”构建锚点索引，并解析旧链接。
// 关键不变量：别名归属永不重新分配；同名无关章节不会接管旧链接。

function uniq(arr) {
  return [...new Set(arr.filter(Boolean))]
}

export function buildIndex(state, { docId, revision, source, frozen = false } = {}) {
  const live = state.live ?? state.nodes.filter((n) => n.status === 'live')
  const nodes = new Map()
  for (const node of state.nodes) nodes.set(node.id, node)

  // 当前版本可读别名 -> 节点（只取节点“自身”名称：显式锚点/当前 slug/自身曾用名）
  const aliasToNode = new Map()
  for (const node of live) {
    for (const name of uniq([node.explicitId, node.slug, ...(node.aliases ?? [])])) {
      if (!aliasToNode.has(name)) aliasToNode.set(name, node.id)
    }
  }

  // 历史归属：别名 -> 真正拥有过该名称的节点。
  // 新节点的“出生名”不进历史归属（否则同名无关新节会错误接管旧链接）；
  // 只有在更早版本就存在、且把该名作为自身别名的节点才计入。
  const aliasOwners = new Map()
  const record = (map, alias, nodeId) => {
    if (!map.has(alias)) map.set(alias, [])
    const list = map.get(alias)
    if (!list.includes(nodeId)) list.push(nodeId)
  }
  // 改名继承：别名 -> 接管它的现存节点
  const inheritedBy = new Map()
  for (const node of state.nodes) {
    const historicalNames = uniq(
      [node.explicitRequested, node.explicitId, ...(node.aliases ?? [])].filter((name) => name && name !== node.slug),
    )
    if (node.slug && node.bornAt != null && node.bornAt < revision) historicalNames.push(node.slug)
    for (const name of historicalNames) record(aliasOwners, name, node.id)
    // 改名链：predecessorAliases 是该节点自己继承下来的旧名，它既是继承人也是跟随目标
    for (const name of uniq(node.predecessorAliases ?? [])) {
      record(inheritedBy, name, node.id)
      record(aliasOwners, name, node.id)
    }
  }

  // 拆分关系
  const splitParents = new Map()
  for (const node of state.nodes) {
    if (node.status === 'deleted' && Array.isArray(node.splitChildren) && node.splitChildren.length) {
      splitParents.set(node.id, node.splitChildren.slice())
    }
    if (node.splitParent) {
      if (!splitParents.has(node.splitParent)) splitParents.set(node.splitParent, [])
      const list = splitParents.get(node.splitParent)
      if (!list.includes(node.id)) list.push(node.id)
    }
  }

  return {
    docId: docId ?? state.docId ?? null,
    revision,
    source: source ?? state.source ?? null,
    frozen,
    builtAt: new Date().toISOString(),
    liveIds: live.map((n) => n.id),
    nodes,
    aliasToNode,
    aliasOwners,
    inheritedBy,
    splitParents,
  }
}

// 解析锚点。绝不把旧链接送给同名但身份无关的章节。
export function resolveAnchor(index, anchor) {
  if (!anchor) return { status: 'gone', reason: 'empty-anchor' }

  // 1) 稳定 id 直达
  const node = index.nodes.get(anchor)
  if (node) {
    if (node.status === 'live') return { status: 'ok', nodeId: node.id, via: 'id' }
    if (index.splitParents.has(anchor)) {
      return { status: 'ambiguous', candidates: index.splitParents.get(anchor), parentId: anchor, reason: 'split' }
    }
    // 节点已删除：若当前存在同名（slug/显式锚点）但身份无关的章节 => foreign，不自动跳
    const deletedName = node.slug || node.explicitId
    if (deletedName) {
      const sameTitle = [...index.aliasToNode.entries()].find(([, id]) => {
        if (id === anchor) return false
        const n = index.nodes.get(id)
        return n && n.status === 'live' && (n.slug === deletedName || (node.explicitId && n.explicitId === deletedName))
      })
      if (sameTitle) {
        return { status: 'foreign', currentNodeId: sameTitle[1], reason: 'unrelated-same-title', anchor }
      }
    }
    return { status: 'gone', nodeId: anchor, reason: 'deleted' }
  }

  const owners = index.aliasOwners.get(anchor) ?? []
  const liveOwners = owners.filter((id) => index.nodes.get(id)?.status === 'live')
  const heirs = (index.inheritedBy.get(anchor) ?? []).filter((id) => index.nodes.get(id)?.status === 'live')
  const candidates = uniq([...liveOwners, ...heirs])

  // 2) 有历史属主：跟随改名 / 一对多歧义 / 删除
  if (owners.length > 0) {
    if (candidates.length === 1) {
      const nodeId = candidates[0]
      const current = index.nodes.get(nodeId)
      const stillOwnName = current && liveOwners.includes(nodeId) && (current.slug === anchor || current.explicitId === anchor)
      return {
        status: stillOwnName ? 'ok' : 'renamed',
        nodeId,
        via: liveOwners.includes(nodeId) ? 'legacy-alias' : 'inherited-alias',
        anchor,
      }
    }
    if (candidates.length > 1) {
      return { status: 'ambiguous', candidates, reason: 'multiple-owners', anchor }
    }
    const splitOwner = owners.find((id) => index.splitParents.has(id))
    if (splitOwner) {
      return { status: 'ambiguous', candidates: index.splitParents.get(splitOwner), parentId: splitOwner, reason: 'split', anchor }
    }
  }

  // 3) 当前别名占用者
  const occupier = index.aliasToNode.get(anchor)
  if (occupier) {
    if (owners.length === 0) {
      return { status: 'ok', nodeId: occupier, via: 'alias', anchor }
    }
    // 旧属主已消失，占用者身份从未拥有该名 => 同名无关，绝不自动跳
    if (!owners.includes(occupier)) {
      return { status: 'foreign', currentNodeId: occupier, reason: 'unrelated-same-title', anchor }
    }
  }

  return { status: 'gone', reason: owners.length ? 'deleted' : 'unknown', anchor, owners }
}

// 冻结索引：深拷贝快照。导出锚点永远以此为准。
export function freezeIndex(index, { exportId }) {
  return {
    ...index,
    exportId,
    frozen: true,
    frozenAt: new Date().toISOString(),
    liveIds: [...index.liveIds],
    aliasToNode: new Map(index.aliasToNode),
    aliasOwners: new Map([...index.aliasOwners].map(([k, v]) => [k, [...v]])),
    inheritedBy: new Map([...index.inheritedBy].map(([k, v]) => [k, [...v]])),
    splitParents: new Map([...index.splitParents].map(([k, v]) => [k, [...v]])),
    nodes: new Map([...index.nodes].map(([k, v]) => [k, cloneNode(v)])),
  }
}

function cloneNode(node) {
  return {
    ...node,
    aliases: [...(node.aliases ?? [])],
    predecessorAliases: [...(node.predecessorAliases ?? [])],
    splitChildren: node.splitChildren ? [...node.splitChildren] : null,
  }
}

export function frozenHref(docSlug, exportId, anchor) {
  return `/p/${encodeURIComponent(docSlug)}/${exportId}#${encodeURIComponent(anchor)}`
}

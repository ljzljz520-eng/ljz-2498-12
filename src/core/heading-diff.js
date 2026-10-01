// 标题序列身份协调（核心不变量）：
//   改名 / 改层级 / 撤销恢复  => 身份沿用；
//   拆分 / 复制 / 同名无关新节 => 一律新身份；
//   判定不确定时宁发新 id（不跳也不能乱跳）。
// 实现：标题序列 LCS 相等区 + hunk 内启发式（显式锚点 > 墓碑结构证据
// > 拆分判定 > 相似度贪心配对）。

import { allocateAliases, allocateExplicit } from './slug.js'
import { createNodeId, fingerprint as fpOf, similarity } from './identity.js'

export const RENAME_KEEP = 0.8
export const PAIR_THRESHOLD = 0.55

export function emptyState() {
  return { revision: 0, nodes: [] }
}

const isLive = (n) => n && n.status === 'live'

function lcsPairs(prevLive, nextHeadings) {
  const eq = (node, h) =>
    node.level === h.level && node.text === h.text && (node.explicitRequested ?? null) === (h.explicitId ?? null)
  const m = prevLive.length
  const n = nextHeadings.length
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = eq(prevLive[i], nextHeadings[j])
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const pairs = []
  let i = 0
  let j = 0
  while (i < m && j < n) {
    if (eq(prevLive[i], nextHeadings[j])) {
      pairs.push([i, j])
      i += 1
      j += 1
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i += 1
    } else {
      j += 1
    }
  }
  return pairs
}

const range = (a, b) => {
  const out = []
  for (let k = a; k < b; k++) out.push(k)
  return out
}

export function reconcileHeadings(prevState, nextHeadings, { revision, now = Date.now(), idFactory = createNodeId } = {}) {
  const prevNodes = prevState?.nodes ?? []
  const prevLive = prevNodes.filter(isLive)
  const tombstones = prevNodes
    .filter((n) => !isLive(n))
    .map((n) => ({ ...n, aliases: [...n.aliases], predecessorAliases: [...(n.predecessorAliases ?? [])] }))
  const events = []
  const warnings = []

  const pairs = lcsPairs(prevLive, nextHeadings)
  const live = []
  const liveById = new Map()
  const place = (node) => {
    live.push(node)
    liveById.set(node.id, node)
  }

  // 相等区节点在 hunk 构造循环中通过 adopt 落位（身份、行位一并更新）

  const adopt = (oldNode, heading) => {
    const node = {
      ...oldNode,
      aliases: [...oldNode.aliases],
      predecessorAliases: [...(oldNode.predecessorAliases ?? [])],
      level: heading.level,
      text: heading.text,
      explicitRequested: heading.explicitId ?? null,
      line: heading.line,
      endLine: heading.endLine,
      fingerprint: fpOf(heading),
      status: 'live',
      revivedFrom: oldNode.revivedFrom ?? null,
      copiedFrom: oldNode.copiedFrom ?? null,
      splitParent: null,
      beforeId: null,
      afterId: null,
      splitChildren: null,
      deletedAt: null,
      deletedRevision: null,
      updatedAt: now,
      rev: revision,
    }
    if (oldNode.text !== heading.text) {
      events.push({ type: 'rename', id: node.id, from: oldNode.text, to: heading.text, revision })
    }
    if (oldNode.level !== heading.level) {
      events.push({ type: 'level-change', id: node.id, from: oldNode.level, to: heading.level, revision })
    }
    place(node)
    return node
  }

  // 构造 hunks（旧索引基于 prevLive，新索引基于 nextHeadings）
  // 先让全部相等区配对节点落位（复制检测等需要在任一 hunk 中都能看到它们）
  for (const [oi, nj] of pairs) adopt(prevLive[oi], nextHeadings[nj])

  // 构造 hunks（相等区之间的旧/新标题）
  const hunks = []
  let cursorOld = 0
  let cursorNew = 0
  for (const [oi, nj] of pairs) {
    if (oi > cursorOld || nj > cursorNew) {
      hunks.push({
        olds: prevLive.slice(cursorOld, oi),
        news: nextHeadings.slice(cursorNew, nj),
        newIndexes: range(cursorNew, nj),
        beforeId: null,
        afterId: null,
      })
    }
    cursorOld = oi + 1
    cursorNew = nj + 1
  }
  if (cursorOld < prevLive.length || cursorNew < nextHeadings.length) {
    hunks.push({
      olds: prevLive.slice(cursorOld),
      news: nextHeadings.slice(cursorNew),
      newIndexes: range(cursorNew, nextHeadings.length),
      beforeId: null,
      afterId: null,
    })
  }

  // hunk 边界 = 文档序中最近的相等区存活节点
  for (const hunk of hunks) {
    const firstNew = hunk.newIndexes[0]
    for (const [oi, nj] of pairs) {
      if (nj < firstNew) hunk.beforeId = prevLive[oi].id
      if (nj > firstNew && hunk.afterId === null) hunk.afterId = prevLive[oi].id
    }
  }

  const usedTombstones = new Set()
  const deletedRefs = []
  // 标题键（层级+归一化文本）；复制检测只看标题，不看正文。
  const headingKeyOf = (h) => `${h.level}:${String(h.text).trim().toLowerCase()}`

  // 边界存活与否直接查相等配对（不依赖 hunk 处理顺序）。
  // 恢复（撤销语义）必须有强结构证据，避免同名无关章节接管身份：
  //  - 双边界命中（前后存活兄弟都一致）；或
  //  - 孤立标题（两边界皆 null）；或
  //  - 前/后单侧非空命中，且另一侧在删除前后均为 null（文档首/尾）。
  const neighborEvidence = (tomb, beforeId, afterId) => {
    const beforeHit = tomb.beforeId != null && tomb.beforeId === beforeId
    const afterHit = tomb.afterId != null && tomb.afterId === afterId
    const beforeEdge = tomb.beforeId == null && beforeId == null
    const afterEdge = tomb.afterId == null && afterId == null
    return (beforeHit || beforeEdge) && (afterHit || afterEdge)
  }

  // 双边界命中优于单边界；用于多墓碑候选排序。
  const boundaryScore = (tomb, beforeId, afterId) => {
    return (tomb.beforeId != null && tomb.beforeId === beforeId ? 2 : 0) +
      (tomb.afterId != null && tomb.afterId === afterId ? 1 : 0)
  }

  for (const hunk of hunks) {
    const { beforeId, afterId } = hunk
    const consumedOld = new Set()
    // decisions[idx] = { node } 已有身份 | { fresh, splitParent? } 需新建
    const decisions = new Array(hunk.news.length).fill(null)

    // 1) 显式锚点绑定：归属永久；同 hunk 内重复出现 => 后到者复制
    const explicitSeen = new Set()
    hunk.news.forEach((heading, idx) => {
      if (!heading.explicitId || explicitSeen.has(heading.explicitId)) return
      const owner = hunk.olds.find((o) => !consumedOld.has(o.id) && o.explicitRequested === heading.explicitId)
      if (owner) {
        consumedOld.add(owner.id)
        explicitSeen.add(heading.explicitId)
        decisions[idx] = { node: adopt(owner, heading) }
      }
    })

    // 2) 墓碑恢复：标题文本与层级完全相同（原标题回来）+ 相邻结构证据命中。
    //    多候选时选边界最匹配者；fingerprint(含正文) 仅用于次级排序。
    hunk.news.forEach((heading, idx) => {
      if (decisions[idx]) return
      const key = headingKeyOf(heading)
      const candidates = tombstones.filter(
        (t) =>
          !usedTombstones.has(t.id) &&
          headingKeyOf(t) === key &&
          neighborEvidence(t, beforeId, afterId),
      )
      if (candidates.length === 0) return
      candidates.sort((a, b) => boundaryScore(b, beforeId, afterId) - boundaryScore(a, beforeId, afterId))
      const tomb = candidates[0]
      usedTombstones.add(tomb.id)
      const node = adopt({ ...tomb, status: 'live' }, heading)
      node.revivedFrom = tomb.id
      // 恢复意味着原身份回来：其曾用名仍是“自身别名”，清掉改名继承链
      node.predecessorAliases = []
      events.push({ type: 'restore', id: node.id, fromTombstone: tomb.id, revision })
      decisions[idx] = { node }
      tombstones.splice(tombstones.indexOf(tomb), 1)
    })

    const remainingOld = () => hunk.olds.filter((o) => !consumedOld.has(o.id))
    const isUnresolved = (d) => !d
    const isFresh = (d) => d && d.fresh === true
    const unresolvedIdx = (arr) => arr.map((d, idx) => (isUnresolved(d) ? idx : -1)).filter((idx) => idx >= 0)
    const remainingIdx = () => unresolvedIdx(decisions)
    const pendingIdx = () => decisions.map((d, idx) => (isUnresolved(d) || isFresh(d) ? idx : -1)).filter((idx) => idx >= 0)

    // 3) 1:1 替换块：先查墓碑恢复（原标题回来），否则视为改名（身份沿用）
    let splitInfo = null
    let ro = remainingOld()
    let rn = remainingIdx()
    if (ro.length === 1 && rn.length === 1) {
      const heading = hunk.news[rn[0]]
      const key = headingKeyOf(heading)
      const tombs = tombstones
        .filter((t) => !usedTombstones.has(t.id) && headingKeyOf(t) === key && neighborEvidence(t, beforeId, afterId))
        .sort((a, b) => boundaryScore(b, beforeId, afterId) - boundaryScore(a, beforeId, afterId))
      if (tombs.length) {
        const tomb = tombs[0]
        usedTombstones.add(tomb.id)
        const node = adopt({ ...tomb, status: 'live' }, heading)
        node.revivedFrom = tomb.id
        node.predecessorAliases = []
        events.push({ type: 'restore', id: node.id, fromTombstone: tomb.id, revision })
        decisions[rn[0]] = { node }
        tombstones.splice(tombstones.indexOf(tomb), 1)
        // 被替换的旧节点（如 B 被恢复的 C 顶替）进入正常删除
        consumedOld.add(ro[0].id)
      } else {
        consumedOld.add(ro[0].id)
        decisions[rn[0]] = { node: adopt(ro[0], heading) }
      }
    }

    // 4) 1:N —— 拆分 或 高相似改名+新增
    ro = remainingOld()
    rn = remainingIdx()
    if (ro.length === 1 && rn.length >= 2) {
      const old = ro[0]
      const scored = rn.map((idx) => ({ idx, sim: similarity(old.text, hunk.news[idx].text) }))
      const strong = scored.filter((s) => s.sim >= RENAME_KEEP)
      const pairable = scored.filter((s) => s.sim >= PAIR_THRESHOLD)
      if (strong.length === 1 && pairable.length === 1) {
        consumedOld.add(old.id)
        decisions[strong[0].idx] = { node: adopt(old, hunk.news[strong[0].idx]) }
      } else {
        // 拆分：旧身份删除，所有新标题发新身份
        consumedOld.add(old.id)
        const childPositions = rn.slice()
        splitInfo = { oldId: old.id, positions: childPositions }
        for (const idx of childPositions) decisions[idx] = { fresh: true, splitParent: old.id }
      }
    }

    // 5) N:M —— 相似度贪心配对（只处理尚无决策的新标题）
    ro = remainingOld()
    rn = remainingIdx()
    if (ro.length > 0 && rn.length > 0) {
      const cand = []
      for (const o of ro) for (const idx of rn) cand.push({ o, idx, sim: similarity(o.text, hunk.news[idx].text) })
      cand.sort((a, b) => b.sim - a.sim)
      for (const c of cand) {
        if (c.sim < PAIR_THRESHOLD || consumedOld.has(c.o.id) || !isUnresolved(decisions[c.idx])) continue
        consumedOld.add(c.o.id)
        decisions[c.idx] = { node: adopt(c.o, hunk.news[c.idx]) }
      }
    }

    // 6) 旧节点 => 软删除（拆分父节点已 consumed，单独入墓碑）。
    // 存活边界在全部 hunk 处理完后按“删除后仍存活的节点序列”统一重算。
    const toDelete = [...remainingOld()]
    if (splitInfo) {
      const splitOld = hunk.olds.find((o) => o.id === splitInfo.oldId)
      if (splitOld && !toDelete.some((o) => o.id === splitOld.id)) toDelete.push(splitOld)
    }
    for (const old of toDelete) {
      const dead = {
        ...old,
        aliases: [...old.aliases],
        predecessorAliases: [...(old.predecessorAliases ?? [])],
        status: 'deleted',
        deletedAt: now,
        deletedRevision: revision,
        beforeId,
        afterId,
        splitChildren: splitInfo?.oldId === old.id ? [] : old.splitChildren ?? null,
        updatedAt: now,
        rev: revision,
      }
      tombstones.push(dead)
      deletedRefs.push(dead)
      events.push({ type: 'delete', id: old.id, reason: splitInfo?.oldId === old.id ? 'split' : 'removed', revision })
    }

    // 7) 新身份落位（复制检测）：未决与 fresh 决策都需物化
    rn = pendingIdx()
    for (const idx of rn) decisions[idx] = decisions[idx] ?? { fresh: true }
    for (const idx of rn) {
      const d = decisions[idx]
      if (!d.fresh) continue
      const heading = hunk.news[idx]
      const fp = fpOf(heading)
      // 复制来源：当前文档中已落位的同标题节点（相等区配对的或同 hunk 早先物化的）
      const sameHeading = live
        .filter((n) => n.status === 'live' && headingKeyOf(n) === headingKeyOf(heading))
        .map((n) => n.id)
      const sourceId = d.splitParent ? null : sameHeading.at(-1) ?? null
      const node = {
        id: idFactory(now),
        level: heading.level,
        text: heading.text,
        explicitId: null,
        explicitRequested: heading.explicitId ?? null,
        slug: null,
        aliases: [],
        predecessorAliases: [],
        bornAt: revision,
        line: heading.line,
        endLine: heading.endLine,
        fingerprint: fp,
        status: 'live',
        revivedFrom: null,
        copiedFrom: sourceId,
        splitParent: d.splitParent ?? null,
        beforeId: null,
        afterId: null,
        splitChildren: null,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
        deletedRevision: null,
        rev: revision,
      }
      place(node)
      if (sourceId) events.push({ type: 'copy', id: node.id, fromId: sourceId, revision })
      events.push({
        type: 'add',
        id: node.id,
        revision,
        ...(d.splitParent ? { splitParent: d.splitParent } : {}),
      })
      decisions[idx] = { node }
    }

    // 回填 split 事件子节点
    if (splitInfo) {
      const childIds = splitInfo.positions.map((idx) => decisions[idx].node?.id).filter(Boolean)
      const tomb = tombstones.find((t) => t.id === splitInfo.oldId)
      if (tomb) tomb.splitChildren = childIds
      events.push({ type: 'split', id: splitInfo.oldId, childIds, revision })
    }
  }

  // 相邻兄弟（最终文档序）
  const ordered = live.slice().sort((a, b) => a.line - b.line)
  ordered.forEach((node, i) => {
    node.beforeId = i > 0 ? ordered[i - 1].id : null
    node.afterId = i + 1 < ordered.length ? ordered[i + 1].id : null
  })

  // 重算每个本版新墓碑的存活边界。
  // prevLive 中保留下来的节点身份按文档序排列；删除节点按其在旧序列的位次，
  // 在“保留节点序列”中定位插入点，前后者即存活边界。
  const retainedOrder = prevLive
    .map((n) => n.id)
    .filter((id) => ordered.some((o) => o.id === id))
  const retainedSet = new Set(retainedOrder)
  for (const dead of deletedRefs) {
    const oldIndex = prevLive.findIndex((n) => n.id === dead.id)
    let beforeId = null
    let afterId = null
    for (let k = oldIndex - 1; k >= 0; k--) {
      if (retainedSet.has(prevLive[k].id)) {
        beforeId = prevLive[k].id
        break
      }
    }
    for (let k = oldIndex + 1; k < prevLive.length; k++) {
      if (retainedSet.has(prevLive[k].id)) {
        afterId = prevLive[k].id
        break
      }
    }
    dead.beforeId = beforeId
    dead.afterId = afterId
  }

  // 同版本别名分配（可读别名层，与身份解耦）
  const slugAlloc = allocateAliases(ordered.map((n) => n.text))
  const explicitAlloc = allocateExplicit(ordered.map((n) => n.explicitRequested))
  ordered.forEach((node, i) => {
    // 改名后，旧 slug 从“自身别名”移入“继承自前身”，避免同名新节错误接管旧链接
    const prevSlug = node.slug
    const slug = slugAlloc[i].slug
    node.slug = slug
    if (prevSlug && prevSlug !== slug) {
      node.aliases = node.aliases.filter((a) => a !== prevSlug)
      if (!node.predecessorAliases.includes(prevSlug)) node.predecessorAliases.push(prevSlug)
    }
    if (!node.aliases.includes(slug)) node.aliases.push(slug)
    if (slugAlloc[i].duplicated) warnings.push({ type: 'duplicate-slug', id: node.id, slug, revision })
    const ex = explicitAlloc[i]
    node.explicitId = ex.explicit
    if (ex.explicit && !node.aliases.includes(ex.explicit)) node.aliases.push(ex.explicit)
    if (ex.conflict) warnings.push({ type: 'duplicate-explicit-anchor', id: node.id, requested: ex.requested, resolved: ex.explicit, revision })
  })

  return {
    revision,
    nodes: [...ordered, ...tombstones],
    live: ordered,
    deleted: tombstones,
    events,
    warnings,
  }
}

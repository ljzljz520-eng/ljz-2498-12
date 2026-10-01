// 磁盘 JSON <-> 运行时 Map（节点中的别名历史等保持普通数组）。

export function hydrate(raw) {
  const map = (entries) => new Map(entries ?? [])
  return {
    documents: new Map((raw.documents ?? []).map((d) => [d.id, d])),
    revisions: map(raw.revisions),
    nodes: map(raw.nodes),
    events: map(raw.events),
    links: map(raw.links),
    exports: map(raw.exports),
  }
}

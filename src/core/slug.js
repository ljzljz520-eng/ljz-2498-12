// 可读别名（slug）工具：仅用于人类可读 URL，绝不作为身份主键。
// 规则：拉丁字母小写、数字保留；CJK 等非拉丁字符保留；空白折叠为连字符。

const EXPLICIT_ANCHOR_RE = /\s*\{#([A-Za-z0-9_-]+)\}\s*$/

export function stripExplicitAnchor(text) {
  const m = String(text ?? '').match(EXPLICIT_ANCHOR_RE)
  if (!m) return { text: String(text ?? ''), explicitId: null }
  return { text: text.slice(0, m.index).trimEnd(), explicitId: m[1] }
}

export function slugify(text) {
  const { text: bare } = stripExplicitAnchor(text)
  const s = bare
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[`*_~]/g, '')
    .trim()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
  return s || 'section'
}

// 同版本内分配唯一可读别名：首次出现保留裸 slug，其余 -2/-3。
export function allocateAliases(texts, { reserved = new Set() } = {}) {
  const used = new Set(reserved)
  return texts.map((text) => {
    const base = slugify(text)
    if (!used.has(base)) {
      used.add(base)
      return { slug: base, duplicated: false }
    }
    let n = 2
    while (used.has(`${base}-${n}`)) n += 1
    const slug = `${base}-${n}`
    used.add(slug)
    return { slug, duplicated: true, ordinal: n }
  })
}

// 显式锚点 {#x} 同样可能重复：加后缀消解并记录冲突。
export function allocateExplicit(ids, { reserved = new Set() } = {}) {
  const used = new Set(reserved)
  return ids.map((id) => {
    if (id == null) return { explicit: null, conflict: false }
    if (!used.has(id)) {
      used.add(id)
      return { explicit: id, conflict: false }
    }
    let n = 2
    while (used.has(`${id}-${n}`)) n += 1
    const explicit = `${id}-${n}`
    used.add(explicit)
    return { explicit, conflict: true, requested: id }
  })
}

// Catalpa 结构解析：前端本地预览与后端保存版解析共用同一份实现。
// 只提取目录关心的结构：标题（行范围、层级、纯文本、显式锚点、正文摘要）。

import { stripExplicitAnchor } from './slug.js'

const FENCE_RE = /^```/
const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/

export function parseHeadings(source) {
  const lines = String(source ?? '').split(/\r?\n/)
  const headings = []
  let inFence = false
  let fenceMarker = ''

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const trimmed = line.trim()
    if (FENCE_RE.test(trimmed)) {
      if (!inFence) {
        inFence = true
        fenceMarker = trimmed.slice(0, 3)
      } else if (trimmed.startsWith(fenceMarker)) {
        inFence = false
      }
      continue
    }
    if (inFence) continue

    const m = trimmed.match(HEADING_RE)
    if (!m) continue
    const level = m[1].length
    const { text, explicitId } = stripExplicitAnchor(m[2])
    headings.push({
      level,
      rawText: m[2],
      text: text.trim(),
      explicitId: explicitId || null,
      line: i, // 0-based
    })
  }

  // 填充 endLine 与正文摘要
  for (let i = 0; i < headings.length; i++) {
    const nextLine = i + 1 < headings.length ? headings[i + 1].line : lines.length
    headings[i].endLine = nextLine - 1
    const body = lines
      .slice(headings[i].line + 1, Math.min(nextLine, headings[i].line + 6))
      .filter((l) => l.trim() !== '')
      .join(' ')
      .slice(0, 200)
    headings[i].body = body
  }

  return headings
}

export function structureSignature(headings) {
  return headings.map((h) => `${h.level}:${h.text}`).join('\n')
}

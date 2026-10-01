// 稳定节点身份工具。

export function hashString(input) {
  let h = 0x811c9dc5
  const s = String(input)
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  // 转为无符号 36 进制
  return (h >>> 0).toString(36)
}

let counter = 0
export function createNodeId(now = Date.now(), rand = Math.random) {
  counter = (counter + 1) % 0xffffff
  const r = Math.floor(rand() * 0xffffff).toString(36)
  return `n_${now.toString(36)}_${r}${counter.toString(36)}`
}

export function contentHash(source) {
  return `sha1-${hashString(String(source ?? '').replace(/\s+$/, ''))}`
}

// 指纹仅用于文本 diff 启发式，不作为身份。
export function fingerprint({ level, text, body = '' }) {
  return hashString(`${level}|${String(text).trim().toLowerCase()}|${String(body).trim().slice(0, 200)}`)
}

export function normalizedText(text) {
  return String(text ?? '')
    .replace(/[`*_~]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

// 编辑距离归一化相似度 [0,1]。
export function similarity(a, b) {
  const x = normalizedText(a)
  const y = normalizedText(b)
  if (x === y) return 1
  if (!x.length || !y.length) return 0
  const m = x.length
  const n = y.length
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...new Array(n).fill(0)])
  for (let j = 0; j <= n; j++) dp[0][j] = j
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = x[i - 1] === y[j - 1] ? 0 : 1
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost)
    }
  }
  return 1 - dp[m][n] / Math.max(m, n)
}

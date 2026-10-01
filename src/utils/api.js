// 目录服务 API 客户端（同源 /api，Vite dev 代理到 3001）。

const BASE = ''

async function request(method, pathname, body) {
  const res = await fetch(`${BASE}${pathname}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const err = new Error(data.error || `HTTP ${res.status}`)
    err.status = res.status
    err.data = data
    throw err
  }
  return data
}

export const api = {
  createDoc: (body) => request('POST', '/api/docs', body),
  getDoc: (id) => request('GET', `/api/docs/${id}`),
  saveDoc: (id, body) => request('PUT', `/api/docs/${id}`, body),
  history: (id) => request('GET', `/api/docs/${id}/history`),
  resolve: (id, anchor) => request('GET', `/api/docs/${id}/resolve?anchor=${encodeURIComponent(anchor)}`),
  createLink: (id, body) => request('POST', `/api/docs/${id}/links`, body),
  listLinks: (id) => request('GET', `/api/docs/${id}/links`),
  createExport: (id, body) => request('POST', `/api/docs/${id}/exports`, body),
  listExports: (id) => request('GET', `/api/docs/${id}/exports`),
}

export async function resolveWithFallback(clientFn, fallback) {
  try {
    return await clientFn()
  } catch (err) {
    return fallback(err)
  }
}

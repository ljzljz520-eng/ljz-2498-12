// 零依赖 JSON 文件存储：原子写（tmp + rename）+ 进程内串行写事务。
// 生产可替换为 SQLite/Postgres，接口保持不变。

import { promises as fs } from 'node:fs'
import { existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { hydrate } from './serialize.js'

export class JsonStore {
  constructor(file) {
    this.file = file
    this.data = null
    this.queue = Promise.resolve()
  }

  async init() {
    mkdirSync(path.dirname(this.file), { recursive: true })
    if (existsSync(this.file)) {
      const raw = JSON.parse(await fs.readFile(this.file, 'utf8'))
      this.data = hydrate(raw)
    } else {
      this.data = {
        documents: new Map(),
        revisions: new Map(), // docId -> [{revision, source, contentHash, createdAt}]
        nodes: new Map(), // docId -> [node...]
        events: new Map(), // docId -> [event...]
        links: new Map(), // docId -> [link...]
        exports: new Map(), // docId -> [frozen...]
      }
      await this.persist()
    }
  }

  async persist() {
    const tmp = `${this.file}.tmp-${process.pid}-${randomUUID()}`
    const payload = JSON.stringify(dehydrate(this.data))
    await fs.writeFile(tmp, payload, 'utf8')
    await fs.rename(tmp, this.file)
  }

  // 串行化所有写事务
  async tx(fn) {
    const run = this.queue.then(async () => {
      const result = await fn(this.data)
      await this.persist()
      return result
    })
    this.queue = run.catch(() => {})
    return run
  }

  read(fn) {
    return fn(this.data)
  }
}

export function dehydrate(data) {
  return {
    documents: [...data.documents.values()],
    revisions: [...data.revisions],
    nodes: [...data.nodes],
    events: [...data.events],
    links: [...data.links],
    exports: [...data.exports],
  }
}

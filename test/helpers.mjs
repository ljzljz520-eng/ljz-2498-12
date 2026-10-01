// 测试辅助：确定性 id 工厂与逐版本演进。
import { parseHeadings } from '../src/core/parser.js'
import { reconcileHeadings, emptyState } from '../src/core/heading-diff.js'
import { buildIndex } from '../src/core/index.js'

export function makeHarness(prefix = 'h') {
  let n = 0
  const idFactory = () => `${prefix}_${(++n).toString(36)}`
  let state = emptyState()
  const snapshots = []

  function rev(source) {
    const revision = state.revision + 1
    state = reconcileHeadings(state, parseHeadings(source), { revision, now: revision * 1000, idFactory })
    state.source = source
    state.docId = 'doc'
    snapshots.push({ revision, source, state })
    return state
  }

  function index(revision = state.revision) {
    const snap = snapshots.find((s) => s.revision === revision) ?? snapshots[snapshots.length - 1]
    return buildIndex(snap.state, { docId: 'doc', revision: snap.revision, source: snap.source })
  }

  return {
    rev,
    index,
    get state() {
      return state
    },
    get live() {
      return state.live
    },
    get deleted() {
      return state.deleted
    },
    find(text) {
      return state.live.find((n) => n.text === text)
    },
    findAll(text) {
      return state.live.filter((n) => n.text === text)
    },
    events(...types) {
      return state.events.filter((e) => types.includes(e.type))
    },
  }
}

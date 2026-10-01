// 前端目录服务：编辑防抖 => 本地 reconcile 出编辑树节点；
// 与预览节点、服务器索引（indexRev）合成 PositionMap；按协议导航。
import { computed, ref, shallowRef } from 'vue'
import { parseHeadings } from '../core/parser.js'
import { reconcileHeadings, emptyState } from '../core/heading-diff.js'
import { buildIndex } from '../core/index.js'
import { buildPositionMap, planNavigation } from '../core/position-map.js'

export function useTocService({ source, debounceMs = 250 } = {}) {
  const localState = shallowRef(emptyState())
  const editorRev = ref(0)
  const previewRev = ref(0)
  const indexRev = ref(0)
  const serverNodes = ref([])
  const serverSource = ref('')
  const dirty = ref(false)
  const warnings = ref([])

  let timer = null
  let seq = 0

  function recomputeEditor() {
    const headings = parseHeadings(source.value ?? '')
    const prev = localState.value
    const next = reconcileHeadings(prev, headings, {
      revision: (prev.revision ?? 0) + 1,
      now: Date.now(),
    })
    seq += 1
    editorRev.value = seq
    localState.value = next
    warnings.value = next.warnings
    dirty.value = true
  }

  function onSourceChange() {
    clearTimeout(timer)
    timer = setTimeout(recomputeEditor, debounceMs)
  }

  const editorNodes = computed(() =>
    localState.value.live.map((n) => ({ id: n.id, line: n.line, level: n.level, text: n.text, loaded: true })),
  )

  // 预览节点：由组件渲染并测量后通过 setPreviewNodes 注入。
  // 仅重排/重测不改变 previewRev（语义版本），用 measureTick 触发响应式更新。
  const measureTick = ref(0)
  const previewNodeMap = ref(new Map())
  // 虚拟目录已加载到窗口的节点 id；未加载节点在映射中为 missing
  const tocLoadedIds = ref(null) // null = 全部加载
  function setPreviewNodes(nodes) {
    previewNodeMap.value = new Map(nodes.map((n) => [n.id, n]))
    previewRev.value = editorRev.value // 预览内容版本跟随当前编辑版本
    measureTick.value += 1
  }
  function setTocWindow({ loadedIds } = {}) {
    tocLoadedIds.value = loadedIds
  }

  const positionMap = computed(() => {
    void measureTick.value // 重测后重算位置，但不改变语义版本
    const loaded = tocLoadedIds.value
    const tocLoaded = loaded == null ? () => true : (id) => loaded.has(id)
    return buildPositionMap({
      editorRev: editorRev.value,
      previewRev: previewRev.value,
      indexRev: indexRev.value,
      editorNodes: editorNodes.value.map((n) => ({ ...n, loaded: tocLoaded(n.id) })),
      previewNodes: editorNodes.value
        .map((n) => previewNodeMap.value.get(n.id))
        .filter(Boolean)
        .map((n) => ({ ...n, loaded: n.loaded !== false && tocLoaded(n.id) })),
      indexNodes: serverNodes.value.map((n) => ({
        id: n.id,
        line: n.line,
        anchor: n.explicitId ?? n.id,
        alias: n.slug,
      })),
    })
  })

  function localIndex() {
    return buildIndex(localState.value, { revision: editorRev.value, source: source.value })
  }

  function planFor(nodeId) {
    return planNavigation(positionMap.value, nodeId)
  }

  // 服务器保存结果回灌
  function adoptServerIndex({ revision, liveNodes, source: savedSource }) {
    indexRev.value = revision
    serverNodes.value = liveNodes
    serverSource.value = savedSource
    dirty.value = false
  }

  return {
    localState,
    editorRev,
    previewRev,
    indexRev,
    editorNodes,
    serverNodes,
    positionMap,
    warnings,
    dirty,
    onSourceChange,
    recomputeEditor,
    setPreviewNodes,
    setTocWindow,
    adoptServerIndex,
    localIndex,
    planFor,
  }
}

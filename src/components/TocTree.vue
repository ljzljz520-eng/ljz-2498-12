<script setup>
import { computed, ref, watch } from 'vue'

const props = defineProps({
  nodes: { type: Array, default: () => [] },
  activeId: { type: String, default: null },
  map: { type: Object, default: () => ({ mappings: {} }) },
})

const emit = defineEmits(['navigate', 'window-loaded'])

const notice = ref('')
let noticeTimer = null
// 文档较大时启用虚拟窗口：初始只渲染前一屏
const VIRTUAL_THRESHOLD = 40
const PAGE = 20
const virtualStart = ref(0)
const virtualEnd = ref(PAGE - 1)
const loadedSet = ref(new Set())
const isVirtual = computed(() => props.nodes.length > VIRTUAL_THRESHOLD)

function ensureLoadedIndex(index) {
  const next = new Set(loadedSet.value)
  const start = Math.max(0, index - 6)
  const end = Math.min(props.nodes.length - 1, index + 6)
  for (let i = start; i <= end; i++) next.add(i)
  loadedSet.value = next
  virtualStart.value = start
  virtualEnd.value = end
}

function ensureVisible(id) {
  const index = props.nodes.findIndex((n) => n.id === id)
  if (index < 0) return false
  ensureLoadedIndex(index)
  return true
}

defineExpose({ ensureVisible })

function statusOf(id) {
  return props.map?.mappings?.[id]?.status ?? 'missing'
}

function flash(text) {
  notice.value = text
  clearTimeout(noticeTimer)
  noticeTimer = setTimeout(() => {
    notice.value = ''
  }, 2200)
}

function isIndexLoaded(index) {
  return !isVirtual.value || loadedSet.value.has(index)
}

function onClick(node, index) {
  const status = statusOf(node.id)
  if (status === 'index-stale') {
    const m = props.map
    flash(`待刷新：索引 v${m.indexRev} / 预览 v${m.previewRev} 不一致，已阻止跳转`)
    return
  }
  if (status === 'deleted') {
    flash('该章节已删除')
    return
  }
  if (!isIndexLoaded(index)) {
    ensureLoadedIndex(index)
    flash('该目录节点此前未加载：已载入窗口，按稳定 id 重新定位（未发生乱跳）')
  } else if (status === 'draft') {
    flash('未保存章节：仅在编辑器内定位（服务器索引尚无此节点）')
  }
  emit('navigate', { id: node.id, status, index })
}

const visible = computed(() => {
  if (!isVirtual.value) return props.nodes.map((n, i) => ({ ...n, index: i, loaded: true }))
  return props.nodes
    .map((n, i) => ({ ...n, index: i, loaded: loadedSet.value.has(i) }))
    .slice(virtualStart.value, virtualEnd.value + 1)
})

// 非虚拟模式：全部 id 已加载；虚拟模式：仅窗口内 id 已加载。
watch(
  [isVirtual, loadedSet, () => props.nodes],
  () => {
    if (!isVirtual.value) {
      emit('window-loaded', { loadedIds: null })
      return
    }
    emit('window-loaded', { loadedIds: new Set([...loadedSet.value].map((i) => props.nodes[i]?.id).filter(Boolean)) })
  },
  { immediate: true },
)

const statusText = {
  synced: '',
  draft: '未保存',
  'index-stale': '待刷新',
  missing: '未加载',
  deleted: '已删除',
}
</script>

<template>
  <nav class="toc-tree">
    <transition name="fade">
      <p v-if="notice" class="toc-notice">{{ notice }}</p>
    </transition>
    <ul>
      <li v-for="node in visible" :key="node.id" :style="{ paddingLeft: `${(node.level - 1) * 12 + 8}px` }">
        <button
          type="button"
          class="toc-item"
          :class="{ active: activeId === node.id, [`is-${statusOf(node.id)}`]: true }"
          @click="onClick(node, node.index)"
        >
          <span class="toc-title">{{ node.text || '（空标题）' }}</span>
          <span v-if="statusOf(node.id) !== 'synced'" class="toc-badge">{{ statusText[statusOf(node.id)] }}</span>
        </button>
      </li>
    </ul>
  </nav>
</template>

<style scoped>
.toc-tree ul {
  list-style: none;
  margin: 0;
  padding: 0;
}
.toc-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  border: 0;
  background: transparent;
  padding: 6px 8px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 13px;
  color: #2f3a4a;
  text-align: left;
}
.toc-item:hover {
  background: #eef3ff;
}
.toc-item.active {
  background: #e2ecff;
  color: #1d4ed8;
  font-weight: 600;
}
.toc-item.is-index-stale,
.toc-item.is-deleted {
  color: #94a3b8;
}
.toc-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.toc-badge {
  margin-left: auto;
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 999px;
  background: #f1f5f9;
  color: #64748b;
  white-space: nowrap;
}
.is-draft .toc-badge {
  background: #fef3c7;
  color: #92400e;
}
.is-index-stale .toc-badge {
  background: #fee2e2;
  color: #b91c1c;
}
.toc-notice {
  margin: 0 0 8px;
  padding: 6px 10px;
  font-size: 12px;
  border-radius: 6px;
  background: #fff7ed;
  border: 1px solid #fed7aa;
  color: #9a3412;
}
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s;
}
</style>

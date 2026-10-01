<script setup>
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useTocService } from './composables/useTocService'
import { api, resolveWithFallback } from './utils/api'
import TocTree from './components/TocTree.vue'
import PreviewPane from './components/PreviewPane.vue'
import { createTocSession } from './core/navigation-session'

const initialDoc = `# Catalpa 编辑器

欢迎使用 **Catalpa 实时预览**。

## 基础语法
- 支持标题、列表、引用
- 支持 *斜体* 与 **粗体**
- 支持 [链接](https://vuejs.org/)

> 右侧预览会跟随左侧编辑器实时更新。

### 代码块
\`\`\`js
const message = "Hello Catalpa"
console.log(message)
\`\`\`
`

const source = ref(initialDoc)
const docId = ref(localStorage.getItem('catalpa.docId') || `local-${Math.random().toString(36).slice(2, 8)}`)
const serverAvailable = ref(false)
const conflict = ref(null)
const saveState = ref('')
const activeId = ref(null)
const editorEl = ref(null)
const previewEl = ref(null)
const returnHint = ref('')

const toc = useTocService({ source, debounceMs: 200 })
watch(source, toc.onSourceChange)

const session = createTocSession({ storage: localStorage })


const lineHeight = 24
function scrollEditorToLine(line) {
  const el = editorEl.value
  if (!el) return
  el.scrollTop = Math.max(0, line * lineHeight - el.clientHeight / 3)
}

async function onNavigate({ id, status }) {
  const m = toc.positionMap.value.mappings[id]
  if (!m) return
  if (m.editor) scrollEditorToLine(m.editor.line)
  activeId.value = id
  session.beginNavigation(id, { from: 'toc' })
  if (status === 'draft') return
  // 预览侧滚动交给用户“返回预览”，此处仅记录
}

function returnToPreview() {
  const resolved = session.resolveReturn(toc.positionMap.value)
  if (!resolved) return
  if (resolved.status === 'synced') {
    previewEl.value?.scrollToId(resolved.anchor)
    activeId.value = resolved.anchor
    returnHint.value = ''
  } else if (resolved.status === 'index-stale') {
    returnHint.value = '待刷新：编辑/预览/索引版本不一致，无法保证定位到同一内容'
  } else if (resolved.status === 'deleted') {
    returnHint.value = '该章节已被删除'
  } else {
    returnHint.value = '待刷新：节点尚未测量/加载'
  }
}

function onMeasured(nodes) {
  toc.setPreviewNodes(nodes)
}
function onInvalidated(reason) {
  // 字体重排/容器变化：坐标失效，PreviewPane 已重发 measured
  if (activeId.value && session.current()) {
    nextTick(() => previewEl.value?.scrollToId(activeId.value))
  }
}

async function save() {
  if (!serverAvailable.value) {
    saveState.value = '服务器不可用：仅本地目录可用（未生成服务器索引）'
    return
  }
  try {
    const base = toc.indexRev || undefined
    const doc = await api.saveDoc(docId.value, { source: source.value, baseRevision: base })
    toc.adoptServerIndex(doc)
    conflict.value = null
    saveState.value = `已保存 v${doc.revision}`
    ensureLinksMigrated(doc)
  } catch (err) {
    if (err.status === 409) {
      conflict.value = err.data
      saveState.value = '保存冲突：远端有新版本'
    } else {
      saveState.value = `保存失败：${err.message}`
    }
  }
}

async function ensureLinksMigrated() {
  // 保存后让公开链接的迁移状态刷新（无操作创建）
}

async function acceptServer() {
  const c = conflict.value
  if (!c) return
  source.value = c.current.source
  toc.adoptServerIndex(c.current)
  conflict.value = null
}

async function initFromServer() {
  const doc = await resolveWithFallback(() => api.getDoc(docId.value), async () => {
    return api.createDoc({ id: docId.value, slug: docId.value, source: source.value })
  })
  serverAvailable.value = true
  if (doc && doc.liveNodes) {
    // 仅在本地未编辑过时对齐；演示中始终采用服务器内容
    toc.adoptServerIndex(doc)
  }
  saveState.value = `已连接服务器 v${doc.revision}`
}

function resetToDemo() {
  source.value = initialDoc
}
function clearAll() {
  source.value = ''
}

const lineCount = computed(() => source.value.split(/\r?\n/).length)
const charCount = computed(() => source.value.length)

onMounted(() => {
  toc.recomputeEditor()
  initFromServer().catch(() => {
    serverAvailable.value = false
    saveState.value = '离线模式：本地目录可用'
  })
})
</script>

<template>
  <div class="page">
    <header class="hero">
      <div>
        <p class="eyebrow">Vue 3 + Vite · 稳定节点目录服务</p>
        <h1>Catalpa 编辑与预览</h1>
        <p class="subtitle">目录以稳定身份同步；拆分/复制产生新身份；版本不一致时“待刷新”而不乱跳。</p>
      </div>
      <div class="stats">
        <span>{{ lineCount }} 行</span>
        <span>{{ charCount }} 字符</span>
        <span class="rev">编辑 v{{ toc.editorRev }} / 预览 v{{ toc.preview }} / 索引 v{{ toc.indexRev }}</span>
      </div>
    </header>

    <div v-if="conflict" class="conflict-banner">
      <strong>跨设备冲突：</strong>服务器已更新到 v{{ conflict.current.revision }}（你的基础版本已过期）。
      <ul>
        <li v-for="e in conflict.tentativeReconcile.events.slice(-6)" :key="e.type + e.id">
          {{ e.type }} · {{ e.id }}<template v-if="e.from"> ← {{ e.from }}</template>
        </li>
      </ul>
      <button type="button" @click="acceptServer">采用服务器版本并刷新映射</button>
    </div>

    <p v-if="saveState" class="save-state">{{ saveState }}</p>
    <p v-if="returnHint" class="save-state warn">{{ returnHint }}</p>

    <main class="workspace three">
      <aside class="panel toc-panel">
        <div class="panel-header">
          <h2>目录</h2>
          <div class="actions">
            <button class="ghost-btn" type="button" @click="returnToPreview">返回预览定位</button>
          </div>
        </div>
        <TocTree
          :nodes="toc.editorNodes"
          :active-id="activeId"
          :map="toc.positionMap"
          @navigate="onNavigate"
          @window-loaded="toc.setTocWindow"
        />
      </aside>

      <section class="panel editor-panel">
        <div class="panel-header">
          <h2>编辑区</h2>
          <div class="actions">
            <button class="ghost-btn" type="button" @click="resetToDemo">恢复示例</button>
            <button class="ghost-btn danger" type="button" @click="clearAll">清空</button>
            <button class="ghost-btn primary" type="button" @click="save">保存（生成索引）</button>
          </div>
        </div>
        <textarea
          ref="editorEl"
          v-model="source"
          class="editor"
          placeholder="在这里输入 Catalpa 内容..."
          spellcheck="false"
        />
      </section>

      <section class="panel preview-panel">
        <div class="panel-header">
          <h2>预览区</h2>
        </div>
        <PreviewPane
          ref="previewEl"
          :source="source"
          :nodes="toc.editorNodes"
          @measured="onMeasured"
          @layout-invalidated="onInvalidated"
        />
      </section>
    </main>
  </div>
</template>

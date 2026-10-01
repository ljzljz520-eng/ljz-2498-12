<script setup>
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { renderCatalpa } from '../utils/catalpa'
import { createAnchorMeasurement } from '../core/navigation-session'

const props = defineProps({
  source: { type: String, default: '' },
  nodes: { type: Array, default: () => [] }, // {id,line,text}
})
const emit = defineEmits(['measured', 'layout-invalidated'])

const root = ref(null)
const html = ref('')

const lineToId = new Map()
function idFor(line) {
  return lineToId.get(line) ?? null
}

function rebuildLineMap() {
  lineToId.clear()
  for (const n of props.nodes) lineToId.set(n.line, n.id)
}

const measurement = createAnchorMeasurement({
  measureEl: (el) => {
    const r = el.getBoundingClientRect()
    const container = root.value?.getBoundingClientRect?.() ?? { top: 0 }
    return { top: r.top - container.top, height: r.height }
  },
  onInvalidate: (reason) => emit('layout-invalidated', reason),
})
let disconnectRo = () => {}

async function renderAndMeasure() {
  rebuildLineMap()
  html.value = renderCatalpa(props.source, { idFor })
  await nextTick()
  const measured = []
  for (const n of props.nodes) {
    const el = root.value?.querySelector(`[data-line="${n.line}"]`)
    if (el) {
      const rect = await measurement.measure(n.id, el)
      measured.push({ id: n.id, line: n.line, top: rect?.top ?? 0, loaded: true })
    } else {
      measured.push({ id: n.id, line: n.line, top: 0, loaded: false })
    }
  }
  emit('measured', measured)
}

watch(() => [props.source, props.nodes], renderAndMeasure, { deep: false })
onMounted(async () => {
  await renderAndMeasure()
  disconnectRo = measurement.observe(root.value)
  if (typeof document !== 'undefined' && document.fonts?.ready) {
    document.fonts.ready.then(() => renderAndMeasure()).catch(() => {})
  }
})
onBeforeUnmount(disconnectRo)

function scrollToId(id) {
  const el = root.value?.querySelector(`#${CSS.escape(id)}`)
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
  return Boolean(el)
}

defineExpose({ scrollToId, remeasure: renderAndMeasure })
</script>

<template>
  <div ref="root" class="preview markdown-body" v-html="html"></div>
</template>

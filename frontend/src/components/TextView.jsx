import { useMemo, useRef } from 'react'
import { createTextIndex } from '../textIndex'

/**
 * 把文本按所有编码边界切成原子段，每段携带覆盖它的编码列表。
 * 区间一律为 Unicode 码位坐标（与 API / 数据库一致）；切原文时经索引
 * 转成 UTF-16 偏移，绝不会把补充平面字符（如 emoji）的代理对切开。
 *
 * 扫线实现：每条标注（先裁剪到 [0, n]，零长 / 越界标注不产生事件）拆成
 * start 处的“开始”与 end 处的“结束”两个事件，按码位位置排序后只扫一遍，
 * 维护当前活动标注集合；同一点先处理结束再处理开始，正好对应半开区间
 * [start, end) 的相邻不重叠。活动下标始终按 codings 数组下标升序维护，
 * 故每段 codings 的顺序与旧实现 codings.filter 全量扫描的结果一致；
 * 复杂度 O(E log E + 输出规模)（E = 标注数 × 2），支撑单篇数千条重叠标注。
 * 不产出空片段（end <= start 直接跳过），空片段自始不会被渲染。
 */
export function buildSegments(content, codings) {
  const idx = createTextIndex(content)
  const n = idx.length
  // [位置, 类型(0=结束先处理, 1=开始后处理), 标注在 codings 中的下标]
  const events = []
  for (let i = 0; i < codings.length; i++) {
    const c = codings[i]
    const s = Math.max(0, c.start)
    const e = Math.min(n, c.end)
    if (s < e) {
      events.push([s, 1, i])
      events.push([e, 0, i])
    }
  }
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1])

  const segments = []
  let active = [] // 活动标注下标，始终升序
  let cursor = 0
  let k = 0

  const emit = (end) => {
    if (end <= cursor) return
    segments.push({
      start: cursor,
      end,
      text: idx.slice(cursor, end),
      codings: active.map((i) => codings[i]),
    })
  }

  while (k < events.length) {
    const p = events[k][0]
    emit(p)
    // 同位置事件一次处理完：先全部结束，再全部开始
    const ending = new Set()
    while (k < events.length && events[k][0] === p && events[k][1] === 0) {
      ending.add(events[k][2])
      k++
    }
    const starting = []
    while (k < events.length && events[k][0] === p && events[k][1] === 1) {
      starting.push(events[k][2])
      k++
    }
    if (ending.size > 0 || starting.length > 0) {
      // active 与 starting 各自升序，归并并剔除 ending；归并总量与输出规模同阶
      const next = []
      let ai = 0
      let si = 0
      while (ai < active.length || si < starting.length) {
        const a = ai < active.length ? active[ai] : Infinity
        const s = si < starting.length ? starting[si] : Infinity
        if (a < s) {
          if (!ending.has(a)) next.push(a)
          ai++
        } else {
          next.push(s)
          si++
        }
      }
      active = next
    }
    cursor = p
  }
  emit(n)
  return segments
}

function hexToRgba(hex, alpha) {
  const m = hex.replace('#', '')
  const n = parseInt(m.length === 3 ? m.split('').map((x) => x + x).join('') : m, 16)
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`
}

function segmentStyle(codings) {
  if (codings.length === 0) return undefined
  const colors = codings.map((c) => c.code_color || '#999')
  if (colors.length === 1) {
    return {
      background: hexToRgba(colors[0], 0.32),
      borderBottom: `2px solid ${colors[0]}`,
    }
  }
  // 多重叠加：均分渐变条带，直观呈现可重叠编码
  const stops = colors
    .map((col, i) => {
      const from = (i / colors.length) * 100
      const to = ((i + 1) / colors.length) * 100
      return `${hexToRgba(col, 0.42)} ${from}%, ${hexToRgba(col, 0.42)} ${to}%`
    })
    .join(', ')
  return {
    background: `linear-gradient(135deg, ${stops})`,
    borderBottom: `2px solid ${colors[colors.length - 1]}`,
  }
}

/**
 * 文本视图：渲染原子段并把鼠标拖选映射回字符区间。
 * DOM Selection / Range 使用 UTF-16 码元偏移，这里统一换算为码位下标后
 * 再回调 onSelect，保证提交给后端的区间按 Unicode 字符定位、不拆代理对。
 */
export default function TextView({ content, codings, selection, flashRange, onSelect }) {
  const ref = useRef(null)
  const segments = useMemo(() => buildSegments(content, codings), [content, codings])
  const index = useMemo(() => createTextIndex(content), [content])

  function locateOffset(node, offset) {
    const container = ref.current
    if (!container) return null
    let el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node
    const span = el && el.closest ? el.closest('[data-s]') : null
    if (!span || !container.contains(span)) return null
    try {
      // span.dataset.s 是码位起点；Range 内文字长度是 UTF-16 码元数，
      // 经索引把“码位起点 + 码元偏移”换算成绝对码位下标
      const spanStart = Number(span.dataset.s)
      const spanUtf16 = index.toUtf16(spanStart)
      const range = document.createRange()
      range.selectNodeContents(span)
      range.setEnd(node, offset)
      return index.toCodePoint(spanUtf16 + range.toString().length)
    } catch {
      return null
    }
  }

  function handleMouseUp() {
    const sel = window.getSelection()
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return
    const start = locateOffset(sel.anchorNode, sel.anchorOffset)
    const end = locateOffset(sel.focusNode, sel.focusOffset)
    if (start == null || end == null) return
    const [s, e] = start <= end ? [start, end] : [end, start]
    if (e > s) onSelect({ start: s, end: e })
  }

  function inRange(seg, range) {
    return range && seg.start < range.end && seg.end > range.start
  }

  return (
    <div
      ref={ref}
      className="text-view"
      onMouseUp={handleMouseUp}
      data-testid="text-view"
    >
      {segments.map((seg) => {
        const classes = ['seg']
        if (seg.codings.length > 0) classes.push('coded')
        if (inRange(seg, selection)) classes.push('selected')
        if (inRange(seg, flashRange)) classes.push('flash')
        const title =
          seg.codings.length > 0
            ? seg.codings
                .map((c) => `${c.code_name} [${c.start}, ${c.end})`)
                .join('\n')
            : undefined
        return (
          <span
            key={seg.start}
            data-s={seg.start}
            data-e={seg.end}
            className={classes.join(' ')}
            style={segmentStyle(seg.codings)}
            title={title}
          >
            {seg.text}
          </span>
        )
      })}
    </div>
  )
}

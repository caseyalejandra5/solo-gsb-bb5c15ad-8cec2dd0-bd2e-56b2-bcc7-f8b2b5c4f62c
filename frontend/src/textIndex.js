/**
 * 区间坐标边界转换（唯一转换入口）
 *
 * 坐标约定：后端 API 与 SQLite 一律以 **Unicode 码位（code point）** 作为字符
 * 下标（Python 的 len(str) / str[a:b]）；浏览器 DOM 拖选（Selection / Range）
 * 与 JS 字符串则以 **UTF-16 码元（code unit）** 计长。
 *
 * 基本多文种平面（BMP，U+0000–U+FFFF，含常用汉字）两种坐标一致；补充平面字符
 * （U+10000 及以上，如 emoji：😀 = U+1F600）在 JS 中占 2 个 UTF-16 码元，
 * 于是“😀甲乙”里“甲”的码位下标是 [1,2)，UTF-16 下标却是 [2,3)——直接混用会让
 * 提交区间错位、高亮把代理对切成两半。
 *
 * 规则：
 *  - 一切进入 / 离开 API、存入 state 的区间始终是码位坐标；
 *  - 仅在浏览器边界（正文分段渲染、拖选回填）经本模块转换；
 *  - 转换时把落在代理对中间的偏移吸附到码位边界，保证不拆分补充平面字符。
 */

/** 字符串的 Unicode 码位数（等价于后端 Python len(str)） */
export function codePointLength(text) {
  let n = 0
  // for...of 按码位迭代，每个代理对只计一次
  for (const _ of text) n += 1
  return n
}

/** 按码位下标切片（等价于后端 Python text[start:end]） */
export function codePointSlice(text, start, end) {
  return Array.from(text)
    .slice(start, end)
    .join('')
}

/** 按码位数截断（不会切开代理对）；超长时返回前 max 个码位加省略号 */
export function codePointTruncate(text, max) {
  const chars = Array.from(text)
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : text
}

function isHighSurrogate(code) {
  return code >= 0xd800 && code <= 0xdbff
}

/**
 * 文本坐标索引：缓存码位下标与 UTF-16 偏移的双向映射。
 * 同一段正文只构建一次，供分段渲染与拖选定位复用。
 */
export function createTextIndex(text) {
  // cpToUtf16[k] = 第 k 个码位起点对应的 UTF-16 偏移；末位为全文码元长度
  const cpToUtf16 = [0]
  let units = 0
  for (const ch of text) {
    units += ch.length
    cpToUtf16.push(units)
  }
  const length = cpToUtf16.length - 1

  /** 码位下标 → UTF-16 偏移（越界值吸附到 0 / 文末） */
  function toUtf16(cp) {
    if (cp <= 0) return 0
    if (cp >= length) return units
    return cpToUtf16[cp]
  }

  /** UTF-16 偏移 → 码位下标；落在代理对中间时吸附到码位边界 */
  function toCodePoint(u16) {
    if (u16 <= 0) return 0
    if (u16 >= units) return length
    // 边界落在高代理与低代理之间（前一码元为高代理）：回退到该码位起点
    if (isHighSurrogate(text.charCodeAt(u16 - 1))) u16 -= 1
    // 二分求满足 cpToUtf16[k] <= u16 的最大 k
    let lo = 0
    let hi = length
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (cpToUtf16[mid] <= u16) lo = mid
      else hi = mid - 1
    }
    return lo
  }

  /** 按码位下标取原文片段（等价 codePointSlice，复用映射表） */
  function slice(cpStart, cpEnd) {
    const s = toUtf16(Math.max(0, cpStart))
    const e = cpEnd === undefined ? units : toUtf16(Math.min(length, Math.max(0, cpEnd)))
    return text.slice(s, e)
  }

  return { length, toUtf16, toCodePoint, slice }
}

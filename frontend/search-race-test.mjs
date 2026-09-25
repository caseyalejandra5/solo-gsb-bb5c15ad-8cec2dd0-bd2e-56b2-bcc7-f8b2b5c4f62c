// 检索批量编码「关键词与命中错配」回归测试（jsdom 真实渲染组件）。
// 覆盖：
//  1. A 检索在途时改成 B 并即时检索 B：只显示 B 的命中，标题绑定 B；
//  2. A 的迟到响应不得覆盖 B 的命中；
//  3. A 检索成功后把输入改成 B：旧命中 / 勾选立即清空，批量按钮消失；
//  4. 清空输入后在途 A 请求迟到，旧命中不得恢复；
//  5. 批量提交载荷的 document_id 与区间属于发起检索时的文档与关键词，
//     结果提示绑定已检索关键词；重复项跳过规则保留；
//  6. 重叠命中（"aa" in "aaa"）全量返回且默认全选；
//  7. 切文档后旧状态清空；旧文档在途检索迟到不落到新文档；
//  8. 批量提交在途时重新检索同一关键词：旧提交立即解除对面板的占用，
//     其迟到成功 / 失败不覆盖新检索的命中、结果提示或按钮状态。
import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></html>', {
  url: 'http://localhost/',
})
globalThis.window = dom.window
globalThis.document = dom.window.document
globalThis.navigator = dom.window.navigator
globalThis.getComputedStyle = dom.window.getComputedStyle
globalThis.HTMLElement = dom.window.HTMLElement
globalThis.Node = dom.window.Node
globalThis.Range = dom.window.Range
globalThis.Selection = dom.window.Selection
dom.window.Element.prototype.scrollIntoView = () => {}

const tick = () => new Promise((r) => setTimeout(r, 0))
const flush = async (n = 8) => {
  for (let i = 0; i < n; i++) await tick()
}

// 文档库：id -> 正文
const DOC_CONTENT = {
  1: '焦虑不安而焦虑发作，之后 aaa',
  2: 'BBBBBBBBBB',
}

function findMatches(content, query) {
  const out = []
  let pos = content.indexOf(query)
  while (pos !== -1) {
    const end = pos + query.length
    out.push({
      start: pos,
      end,
      text: content.slice(pos, end),
      before: content.slice(Math.max(0, pos - 20), pos),
      after: content.slice(end, end + 20),
    })
    pos = content.indexOf(query, pos + 1) // 重叠命中不跳过
  }
  return out
}

// 被挂起的检索请求：key=`${docId}:${query}` -> {resolve, promise}
const held = new Map()
function holdSearch(docId, query) {
  const key = `s:${docId}:${query}`
  let resolve
  const promise = new Promise((r) => {
    resolve = () =>
      r({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            document_id: docId,
            query,
            matches: findMatches(DOC_CONTENT[docId], query),
          }),
      })
  })
  held.set(key, { resolve, promise })
}
function releaseSearch(docId, query) {
  held.get(`s:${docId}:${query}`)?.resolve()
  held.delete(`s:${docId}:${query}`)
}

// 挂起的批量提交
function holdBatch() {
  let resolve
  const promise = new Promise((r) => {
    resolve = () => r(jsonRes({ created: [], skipped: [], codings: [] }))
  })
  held.set('batch', { resolve, promise })
}
// 挂起、且释放时以失败回包的批量提交
function holdBatchFailure() {
  let resolve
  const promise = new Promise((r) => {
    resolve = () =>
      r({
        ok: false,
        status: 500,
        statusText: 'Server Error',
        json: () => Promise.resolve({ detail: '批量写入失败' }),
      })
  })
  held.set('batch', { resolve, promise })
}
function releaseBatch() {
  held.get('batch')?.resolve()
  held.delete('batch')
}

// 让下一个指定关键词的检索失败（一次性）
const failOnce = new Set()
function failNextSearch(docId, query) {
  failOnce.add(`s:${docId}:${query}`)
}

function jsonRes(body) {
  return { ok: true, status: 200, json: () => Promise.resolve(structuredClone(body)) }
}

// 服务端：记录所有批量提交载荷与已存在标注，模拟重复跳过
const batchCalls = []
const existingKeys = new Set()

globalThis.fetch = async (url, options = {}) => {
  const u = new URL(url, 'http://localhost')
  const path = u.pathname
  const method = options.method || 'GET'
  const m = path.match(/^\/api\/documents\/(\d+)\/search$/)
  if (m && method === 'GET') {
    const docId = Number(m[1])
    const query = u.searchParams.get('query')
    const fkey = `s:${docId}:${query}`
    if (failOnce.delete(fkey)) {
      return { ok: false, status: 500, statusText: 'Server Error', json: () => Promise.resolve({ detail: '检索失败' }) }
    }
    const hung = held.get(fkey)
    if (hung) return hung.promise
    return jsonRes({ document_id: docId, query, matches: findMatches(DOC_CONTENT[docId], query) })
  }
  if (path === '/api/codings/batch' && method === 'POST') {
    const body = JSON.parse(options.body)
    batchCalls.push(body)
    if (held.has('batch')) return held.get('batch').promise
    const created = []
    const skipped = []
    for (const it of body.items) {
      const key = `${body.code_id}:${it.start}:${it.end}`
      if (existingKeys.has(key)) {
        skipped.push({ start: it.start, end: it.end, existing_id: 900 + it.start })
      } else {
        existingKeys.add(key)
        created.push({ id: 100 + created.length, start: it.start, end: it.end })
      }
    }
    return jsonRes({ created, skipped, codings: [] })
  }
  return jsonRes({})
}

const React = (await import('react')).default
const { createRoot } = await import('react-dom/client')
const { act } = await import('react-dom/test-utils')
const { default: SearchBatchPanel } = await import('./src/components/SearchBatchPanel.jsx')

const failures = []
function check(name, cond, extra) {
  if (cond) console.log(`PASS  ${name}`)
  else {
    console.log(`FAIL  ${name}`, extra ?? '')
    failures.push(name)
  }
}

const errors = []
const container = document.getElementById('root')
const root = createRoot(container)
let docId = 1

function panelProps() {
  return {
    docId,
    codes: [{ id: 7, name: '编码X' }],
    onApplied: async () => {},
    onError: (e) => errors.push(e.message || String(e)),
  }
}

async function renderPanel() {
  await act(async () => {
    root.render(React.createElement(SearchBatchPanel, panelProps()))
    await flush()
  })
}

async function rerender(newDocId) {
  docId = newDocId
  await act(async () => {
    root.render(React.createElement(SearchBatchPanel, panelProps()))
    await flush()
  })
}

function setNativeValue(el, value) {
  const setter = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value').set
  setter.call(el, value)
  el.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  el.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
}

async function typeKeyword(value) {
  await act(async () => {
    setNativeValue(container.querySelector('.search-bar input'), value)
    await flush()
  })
}

async function submitSearch() {
  await act(async () => {
    container.querySelector('form.search-bar').dispatchEvent(
      new dom.window.Event('submit', { bubbles: true, cancelable: true })
    )
    await flush()
  })
}

const applyBtn = () => container.querySelector('.apply-row .primary-btn')

async function chooseCode() {
  await act(async () => {
    setNativeValue(container.querySelector('.apply-row select'), '7')
    await flush()
  })
}

async function clickBatch() {
  await act(async () => {
    applyBtn().click()
    await flush()
  })
}

await renderPanel()

// ---------- 用例 1：A 在途时改 B 并检索 B，只显示 B；A 迟到响应被丢弃 ----------
holdSearch(1, '焦虑')
await typeKeyword('焦虑')
await submitSearch()
check('A 检索在途显示检索中', container.textContent.includes('检索中'))

// 在途期间把输入改成 B（在途请求必须随输入变化失效）
await typeKeyword('发作')
check('A 在途时改输入：检索中态取消、无命中列表', !container.querySelector('.match-head'))

await submitSearch()
check('B 即时返回：标题显示 B 命中', /「发作」命中 1 处/.test(container.textContent), container.querySelector('.match-stat')?.textContent)

await act(async () => {
  releaseSearch(1, '焦虑') // A 的迟到响应
  await flush()
})
check('A 迟到响应后仍是 B 的命中', /「发作」命中 1 处/.test(container.textContent))
check('迟到响应未产生错误提示', errors.length === 0, errors)

// ---------- 用例 2：A 成功后改输入为 B（未检索）：立即清空，无法批量 ----------
await typeKeyword('焦虑')
await submitSearch()
check('重新检索 A：2 处命中', /「焦虑」命中 2 处/.test(container.textContent))
check('批量按钮存在且默认全选 2 项', applyBtn()?.textContent.includes('批量编码（2）'), applyBtn()?.textContent)

await typeKeyword('BB')
check('输入改为 B 后命中标题立即消失', !container.querySelector('.match-head'))
check('勾选列表立即清空', !container.querySelector('.match-list'))
check('批量按钮立即消失', !applyBtn())
check('清空过程无错误提示', errors.length === 0, errors)

// ---------- 用例 3：清空输入后在途 A 请求迟到，旧命中不得恢复 ----------
holdSearch(1, '焦虑')
await typeKeyword('焦虑')
await submitSearch()
check('挂起的 A 在途', container.textContent.includes('检索中'))
await typeKeyword('') // 改输入即作废
await act(async () => {
  releaseSearch(1, '焦虑')
  await flush()
})
check('A 迟到响应后不恢复旧命中', !container.querySelector('.match-head'))
check('批量按钮不存在', !applyBtn())

// ---------- 用例 4：正常批量提交，载荷绑定当前文档与已检索关键词 ----------
await typeKeyword('焦虑')
await submitSearch()
await chooseCode()
const before = batchCalls.length
await clickBatch()
check('发起一次批量提交', batchCalls.length === before + 1, batchCalls)
const call = batchCalls[batchCalls.length - 1]
check('提交 document_id 为发起检索时的文档 1', call.document_id === 1, call)
check('提交 code_id=7', call.code_id === 7)
check(
  '提交区间恰为「焦虑」两处命中 [0,2) 与 [5,7)',
  JSON.stringify(call.items) === JSON.stringify([{ start: 0, end: 2 }, { start: 5, end: 7 }]),
  call.items
)
check('结果提示绑定已检索关键词', /「焦虑」新增 2 条/.test(container.textContent), container.querySelector('.batch-result')?.textContent)

// ---------- 用例 5：重复项跳过规则保留 ----------
await clickBatch() // 同样勾选再次提交
const call2 = batchCalls[batchCalls.length - 1]
check('重复提交仍发送相同区间', JSON.stringify(call2.items) === JSON.stringify([{ start: 0, end: 2 }, { start: 5, end: 7 }]))
check('结果提示 2 条全部跳过', /跳过 2 条/.test(container.querySelector('.batch-result')?.textContent ?? ''), container.querySelector('.batch-result')?.textContent)

// ---------- 用例 6：重叠命中（"aa" in "aaa"）全量返回并全选 ----------
await typeKeyword('aa')
await submitSearch()
check('重叠命中：「aa」命中 2 处', /「aa」命中 2 处/.test(container.textContent))
const ranges = [...container.querySelectorAll('.match-list code')].map((c) => c.textContent)
check(
  '两个重叠区间 [13,15) 与 [14,16) 都在列表中',
  ranges.includes('[13, 15)') && ranges.includes('[14, 16)'),
  ranges
)
check('默认全选 2 项', applyBtn()?.textContent.includes('批量编码（2）'), applyBtn()?.textContent)

// ---------- 用例 7：新关键词检索失败时，旧关键词命中不得仍可批量写入 ----------
await typeKeyword('焦虑')
await submitSearch()
check('先检索到 A 的命中', /「焦虑」命中 2 处/.test(container.textContent))
failNextSearch(1, '不存在的词')
await typeKeyword('不存在的词')
await submitSearch()
check('B 检索失败后展示错误提示', errors.some((m) => m.includes('检索失败') || m.includes('500')), errors)
check('B 检索失败后 A 的旧命中已清空', !container.querySelector('.match-head'))
check('B 检索失败后批量按钮不存在', !applyBtn())

// ---------- 用例 8：提交在途时修改关键词 / 切文档，迟到结果不落地、按钮不卡死 ----------
errors.length = 0 // 用例 7 的检索失败错误已单独断言，这里重新计数
await typeKeyword('焦虑')
await submitSearch()
await chooseCode()
holdBatch()
await act(async () => {
  applyBtn().click()
  await tick()
})
check('提交在途显示提交中', applyBtn()?.textContent.includes('提交中'), applyBtn()?.textContent)

// 在途期间改关键词：旧命中清空，迟到回包不得恢复
await typeKeyword('发作')
check('提交在途改关键词：命中列表清空', !container.querySelector('.match-head'))
await act(async () => {
  releaseBatch()
  await flush()
})
check('迟到批量结果不渲染', !container.querySelector('.batch-result'))
check('且无错误提示', errors.length === 0, errors)

// 重新检索后功能正常、按钮不再停留在提交中（applying 已随输入作废复位）
await submitSearch() // 输入框当前为「发作」
check('重新检索 B 正常显示', /「发作」命中 1 处/.test(container.textContent))
check('勾选计数正常（1 项）', applyBtn()?.textContent.includes('批量编码（1）'), applyBtn()?.textContent)

// 提交在途时切文档：迟到结果同样不落地
holdBatch()
await act(async () => {
  applyBtn().click()
  await tick()
})
await rerender(2)
check('切文档后输入清空', container.querySelector('.search-bar input').value === '')
await act(async () => {
  releaseBatch()
  await flush()
})
check('旧文档迟到批量结果不落到文档 2 面板', !container.querySelector('.batch-result'))
check('全程未向文档 2 批量写入', batchCalls.every((c) => c.document_id !== 2), batchCalls)

// ---------- 用例 9：文档 2 的检索在途时切到文档 1，迟到回包不落到文档 1 ----------
await rerender(2)
holdSearch(2, 'BB')
await typeKeyword('BB')
await submitSearch() // 文档 2 的检索挂起中
check('文档 2 检索在途', container.textContent.includes('检索中'))
await rerender(1)
check('切到文档 1 后输入清空、无文档 2 的命中', container.querySelector('.search-bar input').value === '' && !/「BB」命中/.test(container.textContent))
await act(async () => {
  releaseSearch(2, 'BB') // 文档 2 的迟到响应
  await flush()
})
check('文档 2 迟到回包后文档 1 面板仍无命中', !container.querySelector('.match-head'))
check('最终未向文档 2 批量写入', batchCalls.every((c) => c.document_id !== 2), batchCalls)

// ---------- 用例 10：提交在途时重新检索同一关键词，旧提交的迟到成功不得占用面板 ----------
errors.length = 0
await typeKeyword('焦虑')
await submitSearch()
check('前置：A 命中显示', /「焦虑」命中 2 处/.test(container.textContent))
await chooseCode()
holdBatch()
await act(async () => {
  applyBtn().click()
  await tick()
})
check('提交在途显示提交中', applyBtn()?.textContent.includes('提交中'), applyBtn()?.textContent)

// 输入不变，直接再次提交检索表单：同一关键词的重新检索
await submitSearch()
check('重新检索后新命中列表渲染', /「焦虑」命中 2 处/.test(container.textContent))
check(
  '旧提交不再占用面板：按钮恢复可提交态',
  applyBtn()?.textContent.includes('批量编码（2）') && !applyBtn()?.disabled,
  applyBtn()?.textContent
)

// 旧提交的迟到成功：不得覆盖新检索的结果区与按钮状态，也不得报错
await act(async () => {
  releaseBatch()
  await flush()
})
check('迟到成功不渲染旧结果提示', !container.querySelector('.batch-result'))
check('迟到成功未产生错误提示', errors.length === 0, errors)
check(
  '迟到成功后按钮仍是可提交态',
  applyBtn()?.textContent.includes('批量编码（2）') && !applyBtn()?.disabled,
  applyBtn()?.textContent
)

// 新检索的命中可正常再次批量提交（批量写入仍可用）
const beforeResubmit = batchCalls.length
await clickBatch()
check('新命中可再次批量提交', batchCalls.length === beforeResubmit + 1, batchCalls.length)
check(
  '再次提交结果提示正常渲染（既有标注全部跳过）',
  /「焦虑」新增 0 条，跳过 2 条/.test(container.querySelector('.batch-result')?.textContent ?? ''),
  container.querySelector('.batch-result')?.textContent
)

// ---------- 用例 11：提交在途时重新检索，旧提交的迟到失败不得报错或占用按钮 ----------
errors.length = 0
await typeKeyword('发作')
await submitSearch()
check('前置：B 命中显示', /「发作」命中 1 处/.test(container.textContent))
await chooseCode()
holdBatchFailure()
await act(async () => {
  applyBtn().click()
  await tick()
})
check('提交在途显示提交中（将失败）', applyBtn()?.textContent.includes('提交中'), applyBtn()?.textContent)
await submitSearch() // 同一关键词重新检索
check(
  '重新检索后按钮恢复可提交态',
  applyBtn()?.textContent.includes('批量编码（1）') && !applyBtn()?.disabled,
  applyBtn()?.textContent
)
await act(async () => {
  releaseBatch() // 以失败回包释放旧提交
  await flush()
})
check('旧提交迟到失败不产生错误提示', errors.length === 0, errors)
check('迟到失败不渲染结果提示', !container.querySelector('.batch-result'))
check(
  '迟到失败后按钮仍是可提交态',
  applyBtn()?.textContent.includes('批量编码（1）') && !applyBtn()?.disabled,
  applyBtn()?.textContent
)

if (failures.length) {
  console.error(`\n${failures.length} 项失败`)
  process.exit(1)
}
console.log('\n全部通过')

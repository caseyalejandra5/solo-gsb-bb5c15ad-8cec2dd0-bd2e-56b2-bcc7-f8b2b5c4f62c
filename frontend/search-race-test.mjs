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
//  8. 提交在途时用「同一关键词」重新检索：新检索解除旧提交对面板的占用，
//     按钮随新命中恢复可用；旧提交迟到成功不得覆盖新结果 / 触发全局刷新；
//     旧提交迟到失败（在新检索成功后或失败时落地）不得覆盖新错误提示或按钮态；
//     旧提交迟到成功不得覆盖更新一次提交的在途态与结果。
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

// 服务端：记录所有批量提交载荷与已存在标注，模拟重复跳过
const batchCalls = []
const existingKeys = new Set()

// 按真实服务端规则计算一次批量提交的结果（放行时刻才结算，模拟真实写入时机）
function batchResponseBody(body) {
  const created = []
  const skipped = []
  for (const it of body.items) {
    const key = `${body.code_id}:${it.start}:${it.end}`
    if (existingKeys.has(key)) {
      skipped.push({ start: it.start, end: it.end, existing_id: 900 + it.start })
    } else {
      existingKeys.add(key)
      created.push({ id: 100 + existingKeys.size, start: it.start, end: it.end })
    }
  }
  return { created, skipped, codings: [] }
}

// 挂起的批量提交（支持多个在途：旧提交未回又重新检索并发起新提交，
// 两个请求按 FIFO 分别放行；放行时可指定成功 / 失败）
const heldBatch = [] // 已挂起、等待请求取走的闸门
const inflightBatch = [] // 已被请求取走、等待放行的闸门
function holdBatch() {
  const gate = {}
  gate.promise = new Promise((resolve) => {
    gate.settle = resolve
  })
  heldBatch.push(gate)
}
// ok=false 以 500 放行，模拟迟到失败
function releaseBatch(ok = true) {
  const gate = inflightBatch.shift()
  if (!gate) return
  gate.settle(
    ok
      ? jsonRes(batchResponseBody(gate.body))
      : {
          ok: false,
          status: 500,
          statusText: 'Server Error',
          json: () => Promise.resolve({ detail: '批量提交失败' }),
        }
  )
}

// 让下一个指定关键词的检索失败（一次性）
const failOnce = new Set()
function failNextSearch(docId, query) {
  failOnce.add(`s:${docId}:${query}`)
}

function jsonRes(body) {
  return { ok: true, status: 200, json: () => Promise.resolve(structuredClone(body)) }
}

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
    const heldGate = heldBatch.shift()
    if (heldGate) {
      heldGate.body = body
      inflightBatch.push(heldGate)
      return heldGate.promise
    }
    return jsonRes(batchResponseBody(body))
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
const applied = { count: 0 }
const container = document.getElementById('root')
const root = createRoot(container)
let docId = 1

function panelProps() {
  return {
    docId,
    codes: [{ id: 7, name: '编码X' }],
    onApplied: async () => {
      applied.count++
    },
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

// ---------- 用例 10：提交在途时用同一关键词重新检索，旧提交迟到成功不得占用 / 覆盖新面板 ----------
errors.length = 0
const appliedBefore10 = applied.count
await rerender(1)
await typeKeyword('焦虑')
await submitSearch()
await chooseCode()
holdBatch()
await clickBatch()
check('用例 10：首次批量提交在途', applyBtn()?.textContent.includes('提交中'), applyBtn()?.textContent)

// 关键操作：提交未回时再次点击「检索」（同一关键词）——必须允许且立即解除旧提交占用
check(
  '提交在途时检索按钮仍可发起同一关键词检索',
  !container.querySelector('form.search-bar button').disabled
)
holdSearch(1, '焦虑')
await submitSearch()
check('重新检索期间显示检索中', container.textContent.includes('检索中'))
check('重新检索期间旧命中面板卸载（命中 / 勾选只绑定最新检索）', !container.querySelector('.match-head'))
await act(async () => {
  releaseSearch(1, '焦虑')
  await flush()
})
check(
  '新检索返回后命中绑定最新检索（2 处、默认全选）',
  /「焦虑」命中 2 处/.test(container.textContent),
  container.querySelector('.match-stat')?.textContent
)
check(
  '【缺陷复现】新命中的批量按钮不再卡在提交中、可操作',
  applyBtn() && !applyBtn().disabled && applyBtn().textContent.includes('批量编码（2）'),
  applyBtn()?.textContent
)

// 旧提交迟到成功：结果、错误提示、按钮状态、全局刷新都不得落到新检索面板
await act(async () => {
  releaseBatch()
  await flush()
})
check('旧提交迟到成功不渲染其结果提示', !container.querySelector('.batch-result'))
check('旧提交迟到成功不触发 onApplied 全局刷新', applied.count === appliedBefore10, applied.count)
check('旧提交迟到成功后按钮仍可操作', applyBtn() && !applyBtn().disabled, applyBtn()?.textContent)
check('旧提交迟到成功不产生错误提示', errors.length === 0, errors)

// 新检索的批量写入照常工作（旧区间在服务端已写入 → 整批跳过，证明写入链路完好）
await clickBatch()
check(
  '新检索后批量提交成功：提示 2 条全部跳过',
  /新增 0 条，跳过 2 条/.test(container.querySelector('.batch-result')?.textContent ?? ''),
  container.querySelector('.batch-result')?.textContent
)
check('新检索的提交成功触发一次 onApplied', applied.count === appliedBefore10 + 1, applied.count)

// ---------- 用例 11：旧提交迟到失败不得覆盖新检索的错误提示或按钮态 ----------
// 11a：新检索本身失败——旧提交的迟到失败不得追加错误，重新检索后按钮不卡死
errors.length = 0
holdBatch()
await clickBatch()
check('用例 11a：批量提交在途', applyBtn()?.textContent.includes('提交中'), applyBtn()?.textContent)
failNextSearch(1, '焦虑')
await submitSearch() // 同一关键词，新检索失败
check('新检索失败展示检索错误', errors.some((m) => m.includes('检索失败')), errors)
await act(async () => {
  releaseBatch(false) // 旧提交迟到失败
  await flush()
})
check(
  '旧提交迟到失败不覆盖新检索错误（不追加批量失败提示）',
  errors.length === 1 && errors[0].includes('检索失败'),
  errors
)
check('旧提交迟到失败后无残留按钮（面板未被卡死）', !applyBtn())
// 失败一次性消耗后，同词再检索成功，按钮恢复后再发起一次在途提交也能正常复位
holdBatch()
await submitSearch()
check(
  '重新检索成功后按钮恢复可用、不停留在提交中',
  applyBtn() && !applyBtn().disabled && applyBtn().textContent.includes('批量编码（2）'),
  applyBtn()?.textContent
)
await clickBatch() // 取走闸门：恢复后的新提交进入在途
check('恢复后的新提交正常显示提交中', applyBtn()?.textContent.includes('提交中'), applyBtn()?.textContent)
await act(async () => {
  releaseBatch()
  await flush()
})
check(
  '恢复后的提交返回时按钮正常复位、结果提示正常',
  applyBtn() && !applyBtn().disabled && /跳过 2 条/.test(container.querySelector('.batch-result')?.textContent ?? ''),
  { btn: applyBtn()?.textContent, result: container.querySelector('.batch-result')?.textContent }
)

// 11b：新检索成功——旧提交迟到失败不得弹出错误或改动按钮
errors.length = 0
holdBatch()
await clickBatch()
await submitSearch() // 同一关键词，检索即时成功
await flush()
check('11b：新检索成功、按钮可操作', applyBtn() && !applyBtn().disabled, applyBtn()?.textContent)
await act(async () => {
  releaseBatch(false) // 旧提交迟到失败
  await flush()
})
check('旧提交迟到失败不产生任何错误提示', errors.length === 0, errors)
check(
  '旧提交迟到失败后按钮仍可操作、不显示提交中',
  applyBtn() && !applyBtn().disabled && applyBtn().textContent.includes('批量编码（2）'),
  applyBtn()?.textContent
)

// ---------- 用例 12：旧提交迟到成功不得覆盖更新一次提交的在途态与结果 ----------
await act(async () => {
  releaseBatch() // 先放行 11b 的在途提交（迟到成功，11b 面板已是最终态，不影响断言）
  await flush()
})
const appliedBefore12 = applied.count
holdBatch()
holdBatch() // 两个在途闸门：旧提交 + 重新检索后的新提交
await clickBatch() // 旧提交（gate 1）
await submitSearch() // 同一关键词重新检索，解除旧提交占用
await flush()
check('重新检索后命中恢复', /「焦虑」命中 2 处/.test(container.textContent))
await clickBatch() // 新提交（gate 2）在途
check('新提交在途显示提交中', applyBtn()?.textContent.includes('提交中'), applyBtn()?.textContent)

await act(async () => {
  releaseBatch() // gate 1（旧提交）迟到成功
  await flush()
})
check('旧提交迟到成功不渲染结果（仍以新提交为准）', !container.querySelector('.batch-result'))
check('【关键】旧提交迟到成功不复位新提交的提交中态', applyBtn()?.textContent.includes('提交中'), applyBtn()?.textContent)
check('旧提交迟到成功不触发 onApplied', applied.count === appliedBefore12, applied.count)

await act(async () => {
  releaseBatch() // gate 2（新提交）返回
  await flush()
})
check('新提交返回后才展示其结果', /跳过 2 条/.test(container.querySelector('.batch-result')?.textContent ?? ''), container.querySelector('.batch-result')?.textContent)
check('新提交返回后按钮恢复可用', applyBtn() && !applyBtn().disabled, applyBtn()?.textContent)
check('仅新提交触发一次 onApplied', applied.count === appliedBefore12 + 1, applied.count)

if (failures.length) {
  console.error(`\n${failures.length} 项失败`)
  process.exit(1)
}
console.log('\n全部通过')

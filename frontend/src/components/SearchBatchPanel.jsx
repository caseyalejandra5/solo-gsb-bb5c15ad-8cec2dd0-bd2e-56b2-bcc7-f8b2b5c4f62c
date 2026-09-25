import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api'

/**
 * 检索批量编码面板：输入字面关键词检索当前文档全部命中（含彼此重叠的命中），
 * 逐项勾选 / 全选后选择一个既有编码批量提交。后端在单事务中校验并写入，
 * 完全相同的既有标注会被跳过；提交成功后由 onApplied 触发全局刷新。
 *
 * 命中、勾选与结果提示始终绑定「发起检索时的文档 + 关键词」：
 *  - 检索成功时把当时的 query 锁进 searchedQuery，标题与结果均显示它而非输入框实时值；
 *  - 输入框一旦偏离 searchedQuery，立即清空旧命中 / 勾选 / 结果并取号，
 *    使在途检索（及其迟到响应）彻底失效；
 *  - 响应落地前核对请求序号、当前文档以及回包自带的 document_id / query；
 *  - 批量提交前再核对所选命中仍属于当前文档与已检索关键词，失配即阻止写入、
 *    清空面板并提示重新检索。
 */
export default function SearchBatchPanel({ docId, codes, onApplied, onError }) {
  const [query, setQuery] = useState('')
  const [searchedQuery, setSearchedQuery] = useState(null) // 命中所属的已检索关键词
  const [matches, setMatches] = useState(null) // null=尚未检索 / 已作废
  const [checked, setChecked] = useState(new Set())
  const [codeChoice, setCodeChoice] = useState('')
  const [searching, setSearching] = useState(false)
  const [applying, setApplying] = useState(false)
  const [result, setResult] = useState(null) // {query, created: [...], skipped: [...]}
  const selectAllRef = useRef(null)
  // 检索 / 批量应用的异步错位守卫：只接受最新一次、且仍属当前文档与关键词的响应
  const reqSeqRef = useRef(0)
  const docIdRef = useRef(docId)
  // searchedQuery 也需要在 await 之后读到最新值：与 docIdRef 一样用 ref 同步
  const searchedQueryRef = useRef(null)
  useEffect(() => {
    docIdRef.current = docId
  }, [docId])
  useEffect(() => {
    searchedQueryRef.current = searchedQuery
  }, [searchedQuery])

  // 切换文档后清空检索状态
  useEffect(() => {
    reqSeqRef.current++ // 使切文档前在途的检索 / 提交响应失效
    setQuery('')
    setSearchedQuery(null)
    setMatches(null)
    setChecked(new Set())
    setResult(null)
    setSearching(false)
    setApplying(false)
  }, [docId])

  const allChecked = matches !== null && matches.length > 0 && checked.size === matches.length
  const someChecked = checked.size > 0 && !allChecked

  // 全选框的半选（indeterminate）状态只能透过 DOM 属性设置
  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = someChecked
  }, [someChecked])

  const selectedItems = useMemo(
    () => (matches ? matches.filter((_, i) => checked.has(i)) : []),
    [matches, checked]
  )

  // 输入变化：只要与发起检索时的关键词不一致（含首次检索仍在途），旧命中 /
  // 勾选 / 结果立即作废，同时取号让在途检索的迟到响应无法再落地
  function handleQueryChange(value) {
    setQuery(value)
    const hasLiveSearch = searching || searchedQuery !== null
    const boundQuery = searching ? query : searchedQuery
    if (hasLiveSearch && value !== boundQuery) {
      reqSeqRef.current++
      setSearchedQuery(null)
      setMatches(null)
      setChecked(new Set())
      setResult(null)
      setSearching(false)
      setApplying(false)
    }
  }

  async function handleSearch(ev) {
    ev.preventDefault()
    if (!query || searching) return
    const targetDocId = docId
    const targetQuery = query
    const seq = ++reqSeqRef.current
    // 发起新检索即作废旧关键词的命中 / 勾选：检索失败时也不会残留可批量写入的旧结果
    setSearching(true)
    setSearchedQuery(null)
    setMatches(null)
    setChecked(new Set())
    setResult(null)
    try {
      const data = await api.searchDocument(targetDocId, targetQuery)
      // 又发起了新检索 / 输入已改 / 已切到其它文档 / 回包文档或关键词不符：
      // 迟到结果一律丢弃
      if (
        seq !== reqSeqRef.current ||
        docIdRef.current !== targetDocId ||
        data.document_id !== targetDocId ||
        data.query !== targetQuery
      ) {
        return
      }
      setMatches(data.matches)
      setSearchedQuery(targetQuery)
      // 默认全选，便于直接批量编码；可再逐项取消
      setChecked(new Set(data.matches.map((_, i) => i)))
    } catch (e) {
      if (seq === reqSeqRef.current && docIdRef.current === targetDocId) onError(e)
    } finally {
      if (seq === reqSeqRef.current && docIdRef.current === targetDocId) setSearching(false)
    }
  }

  function toggleAll() {
    if (!matches) return
    setChecked(allChecked ? new Set() : new Set(matches.map((_, i) => i)))
  }

  function toggleOne(index) {
    setChecked((cur) => {
      const next = new Set(cur)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return next
    })
  }

  // 提交前核对：所选区间必须仍是当前文档、已检索关键词下的命中（区间与命中
  // 文本均一致）。失配说明状态已被竞态污染——阻止写入，清空并提示重新检索。
  function selectionStillFresh(targetDocId, targetQuery, items) {
    if (
      docIdRef.current !== targetDocId ||
      searchedQueryRef.current !== targetQuery ||
      matches === null
    ) {
      return false
    }
    const matchByKey = new Map(matches.map((m) => [`${m.start}-${m.end}`, m]))
    return items.every((it) => matchByKey.get(`${it.start}-${it.end}`)?.text === targetQuery)
  }

  function rejectStaleSelection() {
    reqSeqRef.current++
    setSearchedQuery(null)
    setMatches(null)
    setChecked(new Set())
    setResult(null)
    setApplying(false)
    onError(new Error('检索结果已失效（文档或关键词已变化），请重新检索后再批量写入'))
  }

  async function handleApply() {
    if (!codeChoice || selectedItems.length === 0 || applying) return
    // 提交目标锁定为发起检索时的文档与关键词，区间与该检索结果一一对应
    const targetDocId = docId
    const targetQuery = searchedQuery
    const items = selectedItems.map((m) => ({ start: m.start, end: m.end }))
    if (!selectionStillFresh(targetDocId, targetQuery, items)) {
      rejectStaleSelection()
      return
    }
    const seq = ++reqSeqRef.current
    setApplying(true)
    try {
      const data = await api.batchCreateCodings({
        document_id: targetDocId,
        code_id: Number(codeChoice),
        items,
      })
      // 在途期间切走了文档或关键词已被改写：结果不落在新查询面板
      if (
        seq !== reqSeqRef.current ||
        docIdRef.current !== targetDocId ||
        searchedQueryRef.current !== targetQuery
      ) {
        return
      }
      setResult({ query: targetQuery, ...data })
      await onApplied()
    } catch (e) {
      // 任一非法项时后端整批回滚，这里只提示，无需本地清理
      if (seq === reqSeqRef.current && docIdRef.current === targetDocId) onError(e)
    } finally {
      if (seq === reqSeqRef.current && docIdRef.current === targetDocId) setApplying(false)
    }
  }

  return (
    <section className="search-panel">
      <div className="form-title">检索批量编码</div>

      <form className="search-bar" onSubmit={handleSearch}>
        <input
          value={query}
          onChange={(e) => handleQueryChange(e.target.value)}
          placeholder="输入字面关键词，如：焦虑"
          maxLength={200}
        />
        <button type="submit" className="primary-btn" disabled={!query || searching}>
          {searching ? '检索中…' : '检索'}
        </button>
      </form>

      {matches !== null && searchedQuery !== null && (
        <>
          <div className="match-head">
            <label>
              <input
                ref={selectAllRef}
                type="checkbox"
                checked={allChecked}
                onChange={toggleAll}
              />
              全选
            </label>
            <span className="match-stat">
              「{searchedQuery}」命中 {matches.length} 处，已选 {checked.size} 处
            </span>
          </div>

          {matches.length > 0 ? (
            <ul className="match-list">
              {matches.map((m, i) => (
                <li key={`${m.start}-${m.end}`}>
                  <label>
                    <input
                      type="checkbox"
                      checked={checked.has(i)}
                      onChange={() => toggleOne(i)}
                    />
                    <code>
                      [{m.start}, {m.end})
                    </code>
                    <span className="match-ctx">
                      …{m.before}
                      <mark>{m.text}</mark>
                      {m.after}…
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          ) : (
            <div className="empty">未检索到命中</div>
          )}

          <div className="apply-row">
            <select value={codeChoice} onChange={(e) => setCodeChoice(e.target.value)}>
              <option value="" disabled>
                选择既有编码…
              </option>
              {codes.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <button
              className="primary-btn"
              onClick={handleApply}
              disabled={!codeChoice || selectedItems.length === 0 || applying}
            >
              {applying ? '提交中…' : `批量编码（${selectedItems.length}）`}
            </button>
          </div>
        </>
      )}

      {result && (
        <div className="batch-result">
          「{result.query}」新增 {result.created.length} 条，跳过 {result.skipped.length} 条
          {result.skipped.length > 0 && (
            <ul>
              {result.skipped.map((s) => (
                <li key={`${s.start}-${s.end}`}>
                  <code>
                    [{s.start}, {s.end})
                  </code>
                  与既有标注 #{s.existing_id} 完全相同，已跳过
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <p className="hint">
        提示：按字面文本匹配（含彼此重叠的命中）；完全相同的既有标注自动跳过，其余按保留边界写入。修改关键词后旧命中立即清空，需重新检索方可批量写入。
      </p>
    </section>
  )
}

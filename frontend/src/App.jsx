import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from './api'
import TextView from './components/TextView'
import CodingForm from './components/CodingForm'
import ConflictDialog from './components/ConflictDialog'
import Sidebar from './components/Sidebar'
import CooccurrenceView from './components/CooccurrenceView'
import SpeakerView from './components/SpeakerView'
import DistributionView from './components/DistributionView'
import GapView from './components/GapView'
import TransitionView from './components/TransitionView'
import ReviewView from './components/ReviewView'
import SearchBatchPanel from './components/SearchBatchPanel'
import ImportDialog from './components/ImportDialog'
import MigrationDialog from './components/MigrationDialog'
import MemoView from './components/MemoView'
import { codePointLength, codePointSlice } from './textIndex'
import { useDocFreshness, useRequestTickets } from './useStaleGuard'

export default function App() {
  const [docs, setDocs] = useState([])
  const [docId, setDocId] = useState(null)
  const [docData, setDocData] = useState(null) // {document, codes, codings}
  const [codebook, setCodebook] = useState([]) // 带 usage_count
  const [filters, setFilters] = useState(null) // null=全部；否则 Set(codeId)
  const [selection, setSelection] = useState(null)
  const [editing, setEditing] = useState(null)
  const [conflict, setConflict] = useState(null) // {preview, payload}
  const [flashRange, setFlashRange] = useState(null)
  const [error, setError] = useState(null)
  const [showNewDoc, setShowNewDoc] = useState(false)
  const [newDoc, setNewDoc] = useState({ title: '', content: '' })
  const [view, setView] = useState('text') // text | cooccurrence | speakers | distribution | gaps | transitions
  const [coocStats, setCoocStats] = useState(null)
  const [coocLoading, setCoocLoading] = useState(false)
  const [coocError, setCoocError] = useState(null)
  const [speakerStats, setSpeakerStats] = useState(null)
  const [speakerLoading, setSpeakerLoading] = useState(false)
  const [speakerError, setSpeakerError] = useState(null)
  const [distStats, setDistStats] = useState(null)
  const [distLoading, setDistLoading] = useState(false)
  const [distError, setDistError] = useState(null)
  const [gapStats, setGapStats] = useState(null)
  const [gapLoading, setGapLoading] = useState(false)
  const [gapError, setGapError] = useState(null)
  const [transStats, setTransStats] = useState(null)
  const [transLoading, setTransLoading] = useState(false)
  const [transError, setTransError] = useState(null)
  // 标注抽样复核批次（null = 尚未加载；{batch: null} = 当前文档无批次）
  const [reviewData, setReviewData] = useState(null)
  const [reviewLoading, setReviewLoading] = useState(false)
  const [reviewError, setReviewError] = useState(null)
  const [gapMinLen, setGapMinLen] = useState(1) // 最小缺口长度筛选
  const [gapCursor, setGapCursor] = useState(-1) // 上一处/下一处导航位置
  const [pendingLocate, setPendingLocate] = useState(null)
  const [showImport, setShowImport] = useState(false)
  const [showMigration, setShowMigration] = useState(false)
  // 分析备忘录：active / archived 两个分区（null = 尚未加载）
  const [memoData, setMemoData] = useState(null)
  const [memoLoading, setMemoLoading] = useState(false)
  const [memoError, setMemoError] = useState(null)

  const showError = useCallback((e) => {
    setError(e.message || String(e))
    setTimeout(() => setError(null), 5000)
  }, [])

  // 文档读取 / 刷新的请求次序守卫：每次发起取号，只有最新一次且仍属当前
  // 文档的响应才允许落地，迟到的旧文档 / 旧批次响应一律丢弃
  const { begin: beginDocRequest, isLatest: isLatestDocRequest } = useRequestTickets()
  const { isCurrent } = useDocFreshness(docId)

  // 当前已加载正文（与 docData 同步）：await 之后校验提交所预览的正文是否
  // 仍是界面上这份——跨文档切换或迁移改了正文都会使预览失效
  const docDataRef = useRef(null)
  useEffect(() => {
    docDataRef.current = docData
  }, [docData])

  const loadCodes = useCallback(async () => {
    try {
      setCodebook(await api.listCodes())
    } catch (e) {
      showError(e)
    }
  }, [showError])

  const loadDocument = useCallback(
    async (id) => {
      const seq = beginDocRequest()
      try {
        const data = await api.getDocument(id)
        // 当前文档 + 最新请求双重校验：切到其它文档或又发起了刷新时，
        // 本次迟到响应不得覆盖正文与标注
        if (isLatestDocRequest(seq) && isCurrent(id)) {
          setDocData(data)
        }
      } catch (e) {
        if (isLatestDocRequest(seq) && isCurrent(id)) showError(e)
      }
    },
    [showError, beginDocRequest, isLatestDocRequest, isCurrent]
  )

  useEffect(() => {
    ;(async () => {
      try {
        const list = await api.listDocuments()
        setDocs(list)
        if (list.length > 0) setDocId((cur) => cur ?? list[0].id)
      } catch (e) {
        showError(e)
      }
    })()
    loadCodes()
  }, [loadCodes, showError])

  useEffect(() => {
    if (docId != null) {
      setEditing(null)
      setSelection(null)
      setFlashRange(null)
      // 切换瞬间即丢弃旧文档数据：加载期间正文 / 侧栏 / 编码表单整体卸载，
      // 不可能用旧正文对新文档发起预览或提交
      setDocData(null)
      // 冲突确认若跨过文档切换必须失效：预览正文属于旧文档，不可再提交
      setConflict(null)
      // 跨文档定位的待定位片段指向新文档本身，需保留；其余情况清除
      setPendingLocate((cur) => (cur && cur.docId === docId ? cur : null))
      // 各文档级统计按文档隔离：清空旧数据，避免新文档的统计返回前展示旧结果
      setCoocStats(null)
      setCoocError(null)
      setSpeakerStats(null)
      setSpeakerError(null)
      setGapStats(null)
      setGapError(null)
      setTransStats(null)
      setTransError(null)
      setReviewData(null)
      setReviewError(null)
      // 备忘录数据按文档隔离：切文档后回到备忘录标签时重新加载
      setMemoData(null)
      setMemoError(null)
      loadDocument(docId)
    }
  }, [docId, loadDocument])

  const refresh = useCallback(async () => {
    await Promise.all([loadDocument(docId), loadCodes()])
  }, [docId, loadDocument, loadCodes])

  // 迁移会改动正文长度与文档标注数：同时刷新文档列表（顶栏计数）
  const refreshAfterMigration = useCallback(async () => {
    await Promise.all([refresh(), api.listDocuments().then(setDocs).catch(showError)])
  }, [refresh, showError])

  // ---------- 编码共现统计（随当前文档与编码筛选同步） ----------

  const filteredCodeIds = useMemo(() => {
    if (filters === null) return null
    return codebook.map((c) => c.id).filter((id) => filters.has(id))
  }, [filters, codebook])

  // 文档级统计与文档读取共用一套「取号 + 落地校验」：切文档或标注变化
  // 触发的新请求会让旧请求的迟到响应失效，只展示当前文档的最新结果
  const { begin: beginStatsRequest, isLatest: isLatestStatsRequest } = useRequestTickets()

  const loadCooccurrence = useCallback(async () => {
    if (docId == null) return
    const seq = beginStatsRequest()
    // 全部编码被取消勾选：直接给空结果，不请求后端；取号同样作废旧请求
    if (filteredCodeIds && filteredCodeIds.length === 0) {
      setCoocStats({ document_id: docId, codes: [], pairs: [] })
      setCoocError(null)
      setCoocLoading(false)
      return
    }
    setCoocLoading(true)
    setCoocError(null)
    try {
      const stats = await api.getCooccurrence(docId, filteredCodeIds)
      if (isLatestStatsRequest(seq) && isCurrent(docId)) setCoocStats(stats)
    } catch (e) {
      if (isLatestStatsRequest(seq) && isCurrent(docId)) {
        setCoocStats(null)
        setCoocError(e.message || String(e))
      }
    } finally {
      if (isLatestStatsRequest(seq) && isCurrent(docId)) setCoocLoading(false)
    }
    // docData 变化（新建/编辑/删除标注后 refresh）也要重新统计
  }, [docId, filteredCodeIds, docData, beginStatsRequest, isLatestStatsRequest, isCurrent])

  useEffect(() => {
    loadCooccurrence()
  }, [loadCooccurrence])

  // ---------- 说话人分析（随当前文档与编码筛选同步） ----------

  const loadSpeakers = useCallback(async () => {
    if (docId == null) return
    // 编码全部取消勾选时传空数组：后端仅返回文本长度统计，不带编码列
    const seq = beginStatsRequest()
    setSpeakerLoading(true)
    setSpeakerError(null)
    try {
      const stats = await api.getSpeakerStats(docId, filteredCodeIds)
      if (isLatestStatsRequest(seq) && isCurrent(docId)) setSpeakerStats(stats)
    } catch (e) {
      if (isLatestStatsRequest(seq) && isCurrent(docId)) {
        setSpeakerStats(null)
        setSpeakerError(e.message || String(e))
      }
    } finally {
      if (isLatestStatsRequest(seq) && isCurrent(docId)) setSpeakerLoading(false)
    }
    // docData 变化（新建/编辑/删除标注后 refresh）也要重新统计
  }, [docId, filteredCodeIds, docData, beginStatsRequest, isLatestStatsRequest, isCurrent])

  useEffect(() => {
    loadSpeakers()
  }, [loadSpeakers])

  // ---------- 跨文档编码分布对比（随编码筛选与标注变化同步） ----------

  const loadDistribution = useCallback(async () => {
    // 与说话人分析一致：编码全部取消勾选时传空数组，后端仅返回文档列表
    const seq = beginStatsRequest()
    setDistLoading(true)
    setDistError(null)
    try {
      const stats = await api.getCodeDistribution(filteredCodeIds)
      if (isLatestStatsRequest(seq)) setDistStats(stats)
    } catch (e) {
      if (isLatestStatsRequest(seq)) {
        setDistStats(null)
        setDistError(e.message || String(e))
      }
    } finally {
      if (isLatestStatsRequest(seq)) setDistLoading(false)
    }
    // docData 变化（新建/编辑/删除标注后 refresh）也要重新统计
  }, [filteredCodeIds, docData, beginStatsRequest, isLatestStatsRequest])

  useEffect(() => {
    loadDistribution()
  }, [loadDistribution])

  // ---------- 覆盖缺口（随当前文档与编码筛选同步） ----------

  const loadGaps = useCallback(async () => {
    if (docId == null) return
    // 与说话人分析一致：编码全部取消勾选时传空数组，全文即一个缺口
    const seq = beginStatsRequest()
    setGapLoading(true)
    setGapError(null)
    try {
      const stats = await api.getGaps(docId, filteredCodeIds)
      if (isLatestStatsRequest(seq) && isCurrent(docId)) setGapStats(stats)
    } catch (e) {
      if (isLatestStatsRequest(seq) && isCurrent(docId)) {
        setGapStats(null)
        setGapError(e.message || String(e))
      }
    } finally {
      if (isLatestStatsRequest(seq) && isCurrent(docId)) setGapLoading(false)
    }
    // docData 变化（新建/编辑/删除标注后 refresh）也要重新统计
  }, [docId, filteredCodeIds, docData, beginStatsRequest, isLatestStatsRequest, isCurrent])

  useEffect(() => {
    loadGaps()
  }, [loadGaps])

  // ---------- 编码流转（随当前文档与编码筛选同步） ----------

  const loadTransitions = useCallback(async () => {
    if (docId == null) return
    // 与说话人分析一致：编码全部取消勾选时传空数组，无状态区间与转移
    const seq = beginStatsRequest()
    setTransLoading(true)
    setTransError(null)
    try {
      const stats = await api.getTransitions(docId, filteredCodeIds)
      if (isLatestStatsRequest(seq) && isCurrent(docId)) setTransStats(stats)
    } catch (e) {
      if (isLatestStatsRequest(seq) && isCurrent(docId)) {
        setTransStats(null)
        setTransError(e.message || String(e))
      }
    } finally {
      if (isLatestStatsRequest(seq) && isCurrent(docId)) setTransLoading(false)
    }
    // docData 变化（新建/编辑/删除标注后 refresh）也要重新统计
  }, [docId, filteredCodeIds, docData, beginStatsRequest, isLatestStatsRequest, isCurrent])

  useEffect(() => {
    loadTransitions()
  }, [loadTransitions])

  // ---------- 标注抽样复核（批次内容随文档 / 标注变化刷新新鲜度） ----------

  // 复核批次独立取号：读取与创建 / 结论更新后的落地互不覆盖
  const { begin: beginReviewRequest, isLatest: isLatestReviewRequest } = useRequestTickets()

  const loadReview = useCallback(async () => {
    if (docId == null) return
    const seq = beginReviewRequest()
    setReviewLoading(true)
    setReviewError(null)
    try {
      const data = await api.getReview(docId)
      if (isLatestReviewRequest(seq) && isCurrent(docId)) setReviewData(data)
    } catch (e) {
      if (isLatestReviewRequest(seq) && isCurrent(docId)) {
        setReviewData(null)
        setReviewError(e.message || String(e))
      }
    } finally {
      if (isLatestReviewRequest(seq) && isCurrent(docId)) setReviewLoading(false)
    }
    // docData 变化（标注增删改 / 迁移）后重新读取批次的 stale 标记
  }, [docId, docData, beginReviewRequest, isLatestReviewRequest, isCurrent])

  useEffect(() => {
    loadReview()
  }, [loadReview])

  // ---------- 分析备忘录（在办 / 已归档两个分区，进入标签时加载） ----------

  // 备忘录列表取号：进入标签与写后重载都只保留最新一次结果
  const { begin: beginMemoRequest, isLatest: isLatestMemoRequest } = useRequestTickets()

  const loadMemos = useCallback(async () => {
    if (docId == null) return
    const seq = beginMemoRequest()
    setMemoLoading(true)
    setMemoError(null)
    try {
      const [active, archived] = await Promise.all([
        api.listMemos(docId, 'active'),
        api.listMemos(docId, 'archived'),
      ])
      if (isLatestMemoRequest(seq) && isCurrent(docId)) {
        setMemoData({ active: active.memos, archived: archived.memos })
      }
    } catch (e) {
      if (isLatestMemoRequest(seq) && isCurrent(docId)) setMemoError(e.message || String(e))
    } finally {
      if (isLatestMemoRequest(seq) && isCurrent(docId)) setMemoLoading(false)
    }
  }, [docId, beginMemoRequest, isLatestMemoRequest, isCurrent])

  // 首次进入备忘录标签时加载；在标签页内发生任何备忘录操作后再进来也刷新
  useEffect(() => {
    if (view === 'memo' && memoData === null) loadMemos()
  }, [view, memoData, loadMemos])

  // 最小缺口长度筛选在前端进行，避免每次调整都重新请求
  const visibleGaps = useMemo(
    () => (gapStats?.gaps ?? []).filter((g) => g.length >= gapMinLen),
    [gapStats, gapMinLen]
  )

  // 缺口数据或筛选变化后，导航游标回到未定位状态
  useEffect(() => {
    setGapCursor(-1)
  }, [visibleGaps])

  // ---------- 编码创建 / 编辑（含冲突检测） ----------

  // 标注预览与冲突确认都绑定发起时的文档：跨文档切换（或迁移改变正文）
  // 后本次预览即失效。提交目标始终使用预览时捕获的文档 id，绝不使用提交
  // 瞬间的 live docId，避免按 A 正文的区间写到 B 文档
  function previewStillValid(targetDocId, targetContent) {
    const cur = docDataRef.current
    return !!cur && cur.document.id === targetDocId && cur.document.content === targetContent
  }

  async function doSubmit(payload, resolution) {
    const { docId: targetDocId, codeId, start, end, editing: editTarget } = payload
    if (!previewStillValid(targetDocId, payload.content)) {
      // 预览正文已不是当前正文：静默丢弃，冲突弹窗（如有）一并关闭
      setConflict(null)
      setEditing(null)
      setSelection(null)
      return
    }
    if (editTarget) {
      await api.updateCoding(editTarget.id, {
        code_id: codeId,
        start,
        end,
        resolution,
      })
    } else {
      await api.createCoding({
        document_id: targetDocId,
        code_id: codeId,
        start,
        end,
        resolution,
      })
    }
    setEditing(null)
    setSelection(null)
    setConflict(null)
    await refresh()
  }

  async function handleSubmit({ codeId, newCodeName, start, end, editing: editTarget }) {
    // 入口即锁定目标文档与预览正文；之后任何 await 期间的切换都不会改向
    const targetDocId = docId
    const targetContent = docDataRef.current?.document.content ?? null
    if (targetDocId == null || targetContent === null) return
    try {
      let finalCodeId = codeId
      if (newCodeName) {
        const created = await api.createCode(newCodeName)
        if (!previewStillValid(targetDocId, targetContent)) return
        finalCodeId = created.id
      }
      const preview = await api.previewCoding({
        document_id: targetDocId,
        code_id: finalCodeId,
        start,
        end,
        exclude_id: editTarget ? editTarget.id : null,
      })
      // 预览返回时若已切文档 / 正文已变：本次预览失效，不弹冲突框也不提交
      if (!previewStillValid(targetDocId, targetContent)) return
      const payload = {
        docId: targetDocId,
        content: targetContent,
        codeId: finalCodeId,
        start,
        end,
        editing: editTarget,
      }
      if (preview.has_conflicts) {
        setConflict({ preview, payload })
      } else {
        await doSubmit(payload, 'keep')
      }
    } catch (e) {
      if (previewStillValid(targetDocId, targetContent)) showError(e)
    }
  }

  async function handleResolve(resolution) {
    // 冲突确认可能发生在预览返回很久之后：再次校验预览正文仍属当前文档
    const { payload } = conflict
    if (!previewStillValid(payload.docId, payload.content)) {
      setConflict(null)
      return
    }
    try {
      await doSubmit(payload, resolution)
    } catch (e) {
      showError(e)
      setConflict(null)
    }
  }

  // ---------- 侧栏操作 ----------

  async function handleDeleteCoding(cg) {
    if (!window.confirm(`删除编码标注 #${cg.id}（${cg.code_name}）？`)) return
    try {
      await api.deleteCoding(cg.id)
      await refresh()
    } catch (e) {
      showError(e)
    }
  }

  async function handleRenameCode(code) {
    const name = window.prompt('新的编码名：', code.name)
    if (!name || name.trim() === code.name) return
    try {
      await api.updateCode(code.id, { name: name.trim() })
      await refresh()
    } catch (e) {
      showError(e)
    }
  }

  async function handleDeleteCode(code) {
    if (!window.confirm(`删除编码「${code.name}」及其全部标注？`)) return
    try {
      await api.deleteCode(code.id)
      await refresh()
    } catch (e) {
      showError(e)
    }
  }

  function scrollToRange(range) {
    const spans = document.querySelectorAll('.text-view [data-s]')
    for (const span of spans) {
      const s = Number(span.dataset.s)
      const e = Number(span.dataset.e)
      if (s < range.end && e > range.start) {
        span.scrollIntoView({ behavior: 'smooth', block: 'center' })
        break
      }
    }
  }

  function handleLocate(cg) {
    const range = { start: cg.start, end: cg.end }
    setFlashRange(range)
    scrollToRange(range)
    setTimeout(() => setFlashRange(null), 1800)
  }

  // 共现矩阵 / 说话人分析片段 → 切回正文并定位高亮
  function handleLocateSegment(seg) {
    setView('text')
    setPendingLocate({ docId, start: seg.start, end: seg.end })
  }

  // ---------- 标注抽样复核 ----------

  async function handleCreateReview(codeSettings) {
    const targetDocId = docId
    const seq = beginReviewRequest()
    try {
      const data = await api.createReview(targetDocId, codeSettings)
      // 切换走或已有更新的批次请求时，丢弃本次回包
      if (isLatestReviewRequest(seq) && isCurrent(targetDocId)) setReviewData(data)
      setReviewError(null)
    } catch (e) {
      if (isLatestReviewRequest(seq) && isCurrent(targetDocId)) showError(e)
      throw e
    }
  }

  async function handleRegenerateReview() {
    const batch = reviewData?.batch
    if (!batch) return
    if (batch.counts.total > 0) {
      const ok = window.confirm(
        '重新生成抽样将按当前文档与标注抽取新的复核队列，并清空已有的通过 / 需修订结论，是否继续？'
      )
      if (!ok) return
    }
    const targetDocId = docId
    const seq = beginReviewRequest()
    try {
      const data = await api.createReview(
        targetDocId,
        batch.codes.map((s) => ({
          code_id: s.code_id,
          sample_size: s.sample_size,
        }))
      )
      if (isLatestReviewRequest(seq) && isCurrent(targetDocId)) setReviewData(data)
      setReviewError(null)
    } catch (e) {
      if (isLatestReviewRequest(seq) && isCurrent(targetDocId)) showError(e)
    }
  }

  async function handleDeleteReview() {
    const targetDocId = docId
    const seq = beginReviewRequest()
    try {
      await api.deleteReview(targetDocId)
      if (isLatestReviewRequest(seq) && isCurrent(targetDocId)) setReviewData({ batch: null })
    } catch (e) {
      if (isLatestReviewRequest(seq) && isCurrent(targetDocId)) showError(e)
    }
  }

  async function handlePatchReview(itemId, status, note) {
    const targetDocId = docId
    const seq = beginReviewRequest()
    try {
      const data = await api.updateReviewItem(targetDocId, itemId, status, note)
      if (isLatestReviewRequest(seq) && isCurrent(targetDocId)) setReviewData(data)
      setReviewError(null)
    } catch (e) {
      if (isLatestReviewRequest(seq) && isCurrent(targetDocId)) showError(e)
      throw e
    }
  }

  // 复核队列「定位正文」：切回正文并闪烁定位
  function handleLocateReviewItem(item) {
    setView('text')
    setPendingLocate({ docId, start: item.start, end: item.end })
  }

  // ---------- 分析备忘录 ----------

  async function handleCreateMemo(payload) {
    const created = await api.createMemo(docId, payload)
    await loadMemos()
    return created
  }

  async function handleUpdateMemo(memoId, patch) {
    await api.updateMemo(docId, memoId, patch)
    await loadMemos()
  }

  async function handleDeleteMemo(memoId) {
    await api.deleteMemo(docId, memoId)
    await loadMemos()
  }

  async function handleAddMemoEvidence(memoId, codingIds) {
    await api.addMemoEvidence(docId, memoId, codingIds)
    await loadMemos()
  }

  async function handleRemoveMemoEvidence(memoId, evidenceId) {
    await api.removeMemoEvidence(docId, memoId, evidenceId)
    await loadMemos()
  }

  // 证据「定位正文」：切回正文，闪烁关联时快照区间（已变化证据按当前区间定位）
  function handleLocateMemoEvidence(ev) {
    const range =
      ev.state === 'changed' && ev.current
        ? { start: ev.current.start, end: ev.current.end }
        : { start: ev.start, end: ev.end }
    setView('text')
    setPendingLocate({ docId, ...range })
  }

  // 分布对比单元格 → 切到目标文档正文并定位首个对应片段
  function handleLocateCell(documentId, seg) {
    setDocId(documentId)
    setView('text')
    setPendingLocate({ docId: documentId, start: seg.start, end: seg.end })
  }

  // 覆盖缺口：上一处/下一处导航，循环移动并切回正文闪烁定位
  function handleGapNavigate(dir) {
    if (visibleGaps.length === 0) return
    const next =
      gapCursor < 0
        ? dir > 0
          ? 0
          : visibleGaps.length - 1
        : (gapCursor + dir + visibleGaps.length) % visibleGaps.length
    setGapCursor(next)
    handleLocateSegment(visibleGaps[next])
  }

  // 覆盖缺口：点击某条缺口 → 记住位置并切回正文定位
  function handleGapLocate(gap, index) {
    setGapCursor(index)
    handleLocateSegment(gap)
  }

  // 覆盖缺口：把整段缺口区间带入编码表单（复用拖选填表，提交仍走冲突预览）
  function handleGapToForm(gap) {
    setEditing(null)
    setSelection({ start: gap.start, end: gap.end })
    setView('text')
    setPendingLocate({ docId, start: gap.start, end: gap.end })
  }

  // 正文渲染完成后处理来自统计视图的待定位片段
  useEffect(() => {
    if (view !== 'text' || !pendingLocate) return
    // 跨文档定位需等目标文档加载完成，避免滚动到旧文档的同名区间
    if (!docData || docData.document.id !== pendingLocate.docId) return
    const range = pendingLocate
    setFlashRange(range)
    // 等视图切换后的 DOM 渲染完成再滚动
    const t = setTimeout(() => scrollToRange(range), 60)
    const clear = setTimeout(() => {
      setFlashRange(null)
      setPendingLocate(null)
    }, 2200)
    return () => {
      clearTimeout(t)
      clearTimeout(clear)
    }
  }, [view, pendingLocate, docData])

  function toggleFilter(id) {
    setFilters((cur) => {
      const next = new Set(cur === null ? codebook.map((c) => c.id) : cur)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next.size === codebook.length ? null : next
    })
  }

  // ---------- 文档 ----------

  async function handleCreateDocument(ev) {
    ev.preventDefault()
    if (!newDoc.title.trim() || !newDoc.content.trim()) return
    try {
      const created = await api.createDocument(newDoc.title.trim(), newDoc.content)
      const list = await api.listDocuments()
      setDocs(list)
      setDocId(created.id)
      setShowNewDoc(false)
      setNewDoc({ title: '', content: '' })
    } catch (e) {
      showError(e)
    }
  }

  // ---------- 派生数据 ----------

  const visibleCodings = useMemo(() => {
    if (!docData) return []
    if (filters === null) return docData.codings
    return docData.codings.filter((c) => filters.has(c.code_id))
  }, [docData, filters])

  // 每种编码在当前文档的标注数（抽样设置表单使用，不受编码筛选影响）
  const codingCounts = useMemo(() => {
    const map = {}
    for (const c of docData?.codings ?? []) {
      map[c.code_id] = (map[c.code_id] ?? 0) + 1
    }
    return map
  }, [docData])

  const sidebarCodings = useMemo(() => {
    if (!docData) return []
    const content = docData.document.content
    // 区间为码位下标：按码位切片，保证含 emoji 时侧栏摘录与后端一致
    return visibleCodings.map((c) => ({
      ...c,
      text: codePointSlice(content, c.start, c.end),
    }))
  }, [docData, visibleCodings])

  // 只渲染当前文档的最新结果：切换加载期间（或迟到响应与当前 id 不符时）
  // 内容区显示加载态，旧正文、侧栏与编码表单都不会对新文档产生任何操作；
  // 顶栏与文档切换器保留，便于连续切换文档
  const docReady = !!docData && docData.document.id === docId
  const doc = docReady ? docData.document : null
  const codings = docReady ? docData.codings : null

  return (
    <div className="app">
      <header className="topbar">
        <h1>访谈转录质性分析工作台</h1>
        <div className="doc-switcher">
          <select value={docId ?? ''} onChange={(e) => setDocId(Number(e.target.value))}>
            {docs.map((d) => (
              <option key={d.id} value={d.id}>
                {d.title}（{d.coding_count} 条标注）
              </option>
            ))}
          </select>
          <button onClick={() => setShowNewDoc((v) => !v)}>
            {showNewDoc ? '收起' : '＋ 新建文档'}
          </button>
          <a
            className="btn"
            href={docReady ? api.exportUrl(docId) : undefined}
            download
            aria-disabled={!docReady}
            style={!docReady ? { opacity: 0.5, pointerEvents: 'none' } : undefined}
          >
            导出 JSON
          </a>
          <button
            onClick={() => docReady && setShowImport(true)}
            disabled={!docReady}
          >
            导入标注包
          </button>
          <button
            onClick={() => docReady && setShowMigration(true)}
            disabled={!docReady}
          >
            文档版本迁移
          </button>
        </div>
      </header>

      {showNewDoc && (
        <form className="new-doc" onSubmit={handleCreateDocument}>
          <input
            placeholder="文档标题，如：访谈记录 A-02"
            value={newDoc.title}
            onChange={(e) => setNewDoc({ ...newDoc, title: e.target.value })}
          />
          <textarea
            placeholder="粘贴访谈转录全文…"
            rows={5}
            value={newDoc.content}
            onChange={(e) => setNewDoc({ ...newDoc, content: e.target.value })}
          />
          <button type="submit" className="primary-btn">
            创建文档
          </button>
        </form>
      )}

      {error && <div className="error-banner">{error}</div>}

      {!docReady ? (
        <div className="loading">加载中…</div>
      ) : (
      <main className="layout">
        <section className="text-panel">
          <div className="doc-meta">
            <strong>{doc.title}</strong>
            <span>
              全文 {codePointLength(doc.content)} 字 · {codings.length} 条编码标注
              {filters !== null && `（筛选后 ${visibleCodings.length} 条）`}
            </span>
          </div>
          <div className="view-tabs" role="tablist">
            <button
              role="tab"
              aria-selected={view === 'text'}
              className={view === 'text' ? 'active' : ''}
              onClick={() => setView('text')}
            >
              正文标注
            </button>
            <button
              role="tab"
              aria-selected={view === 'cooccurrence'}
              className={view === 'cooccurrence' ? 'active' : ''}
              onClick={() => setView('cooccurrence')}
            >
              编码共现
            </button>
            <button
              role="tab"
              aria-selected={view === 'speakers'}
              className={view === 'speakers' ? 'active' : ''}
              onClick={() => setView('speakers')}
            >
              说话人分析
            </button>
            <button
              role="tab"
              aria-selected={view === 'distribution'}
              className={view === 'distribution' ? 'active' : ''}
              onClick={() => setView('distribution')}
            >
              分布对比
            </button>
            <button
              role="tab"
              aria-selected={view === 'gaps'}
              className={view === 'gaps' ? 'active' : ''}
              onClick={() => setView('gaps')}
            >
              覆盖缺口
            </button>
            <button
              role="tab"
              aria-selected={view === 'transitions'}
              className={view === 'transitions' ? 'active' : ''}
              onClick={() => setView('transitions')}
            >
              编码流转
            </button>
            <button
              role="tab"
              aria-selected={view === 'review'}
              className={view === 'review' ? 'active' : ''}
              onClick={() => setView('review')}
            >
              标注复核
            </button>
            <button
              role="tab"
              aria-selected={view === 'memo'}
              className={view === 'memo' ? 'active' : ''}
              onClick={() => setView('memo')}
            >
              分析备忘录
            </button>
          </div>
          {view === 'text' ? (
            <TextView
              content={doc.content}
              codings={visibleCodings}
              selection={selection}
              flashRange={flashRange}
              onSelect={(range) => {
                setSelection(range)
                if (editing) setEditing(null)
              }}
            />
          ) : view === 'cooccurrence' ? (
            <CooccurrenceView
              stats={coocStats}
              loading={coocLoading}
              error={coocError}
              onLocateSegment={handleLocateSegment}
            />
          ) : view === 'speakers' ? (
            <SpeakerView
              stats={speakerStats}
              loading={speakerLoading}
              error={speakerError}
              onLocateSegment={handleLocateSegment}
            />
          ) : view === 'gaps' ? (
            <GapView
              stats={gapStats}
              loading={gapLoading}
              error={gapError}
              gaps={visibleGaps}
              minLen={gapMinLen}
              onMinLenChange={setGapMinLen}
              cursor={gapCursor}
              onNavigate={handleGapNavigate}
              onLocate={handleGapLocate}
              onBringToForm={handleGapToForm}
            />
          ) : view === 'transitions' ? (
            <TransitionView
              stats={transStats}
              loading={transLoading}
              error={transError}
              onLocateInstance={handleLocateSegment}
            />
          ) : view === 'review' ? (
            <ReviewView
              key={`review-${docId}`}
              batch={reviewData?.batch ?? null}
              loading={reviewLoading}
              error={reviewError}
              codes={codebook}
              codingCounts={codingCounts}
              onCreate={handleCreateReview}
              onRegenerate={handleRegenerateReview}
              onDelete={handleDeleteReview}
              onPatch={handlePatchReview}
              onLocate={handleLocateReviewItem}
            />
          ) : view === 'memo' ? (
            <MemoView
              key={`memo-${docId}`}
              docId={docId}
              memos={memoData}
              loading={memoLoading}
              error={memoError}
              codings={codings}
              onCreate={handleCreateMemo}
              onUpdate={handleUpdateMemo}
              onDelete={handleDeleteMemo}
              onAddEvidence={handleAddMemoEvidence}
              onRemoveEvidence={handleRemoveMemoEvidence}
              onLocate={handleLocateMemoEvidence}
            />
          ) : (
            <DistributionView
              stats={distStats}
              loading={distLoading}
              error={distError}
              onLocateCell={handleLocateCell}
            />
          )}
        </section>

        <div className="right-panel">
          <CodingForm
            codes={codebook}
            content={doc.content}
            selection={selection}
            editing={editing}
            onSubmit={handleSubmit}
            onCancelEdit={() => setEditing(null)}
          />
          <SearchBatchPanel
            docId={docId}
            codes={codebook}
            onApplied={refresh}
            onError={showError}
          />
          <Sidebar
            codes={codebook}
            codings={sidebarCodings}
            filters={filters}
            onToggleFilter={toggleFilter}
            onClearFilters={() => setFilters(null)}
            onRenameCode={handleRenameCode}
            onDeleteCode={handleDeleteCode}
            onLocateCoding={handleLocate}
            onEditCoding={(cg) => {
              setEditing(cg)
              setSelection(null)
            }}
            onDeleteCoding={handleDeleteCoding}
          />
        </div>
      </main>
      )}

      {docReady && conflict && (
        <ConflictDialog
          preview={conflict.preview}
          content={doc.content}
          onResolve={handleResolve}
          onCancel={() => setConflict(null)}
        />
      )}

      {docReady && showImport && (
        <ImportDialog
          key={docId}
          docId={docId}
          onClose={() => setShowImport(false)}
          onImported={refresh}
          onLocate={handleLocateSegment}
        />
      )}

      {docReady && showMigration && (
        <MigrationDialog
          key={`mig-${docId}`}
          docId={docId}
          oldContent={doc.content}
          onClose={() => setShowMigration(false)}
          onMigrated={refreshAfterMigration}
        />
      )}
    </div>
  )
}

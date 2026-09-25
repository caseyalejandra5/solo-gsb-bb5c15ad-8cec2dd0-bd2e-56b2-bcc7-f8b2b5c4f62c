import { useEffect, useMemo, useState } from 'react'
import { api } from '../api'
import { codePointTruncate } from '../textIndex'

/** 压缩空白并按码位截断（不拆 emoji） */
function excerpt(text, max = 60) {
  if (text == null) return ''
  const flat = text.replace(/\s+/g, ' ').trim()
  return codePointTruncate(flat, max)
}

/** 后端时间为 UTC（datetime('now')），转成本地时区展示 */
function fmtTime(s) {
  if (!s) return ''
  const d = new Date(s.replace(' ', 'T') + 'Z')
  if (Number.isNaN(d.getTime())) return s
  const pad = (n) => String(n).padStart(2, '0')
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`
  )
}

const TABS = [
  ['active', '在办备忘录'],
  ['archived', '已归档'],
]

const STATE_META = {
  current: { label: '证据有效', cls: 'me-current' },
  changed: { label: '原标注已变化', cls: 'me-changed' },
  missing: { label: '原标注已删除', cls: 'me-missing' },
}

/** 证据卡片：始终展示关联时的快照原文，变化 / 删除时明确标示 */
function EvidenceCard({ ev, archived, onRemove, onLocate }) {
  const meta = STATE_META[ev.state] ?? STATE_META.current
  return (
    <li className={`me-card ${meta.cls}`}>
      <div className="me-head">
        <span className="dot" style={{ background: ev.color ?? '#9aa1ad' }} />
        <strong>{ev.code_name}</strong>
        <code>[{ev.start}, {ev.end})</code>
        <span className={`me-state ${meta.cls}`}>{meta.label}</span>
        {!archived && (
          <button
            type="button"
            className="me-remove"
            title="移除该证据关联（不影响原标注）"
            onClick={() => onRemove(ev)}
          >
            ×
          </button>
        )}
      </div>

      <div className="me-excerpt" title={ev.excerpt}>
        {ev.excerpt}
      </div>

      {ev.state === 'changed' && ev.current && (
        <div className="me-current" title={ev.current.excerpt}>
          <span className="me-current-label">标注现已改为</span>
          <span className="dot" style={{ background: ev.current.color ?? '#9aa1ad' }} />
          <strong>{ev.current.code_name}</strong>
          <code>
            [{ev.current.start}, {ev.current.end})
          </code>
          <span className="me-current-text">{excerpt(ev.current.excerpt, 80)}</span>
        </div>
      )}
      {ev.state === 'missing' && (
        <div className="me-current me-missing-note">
          原标注已被删除，以上为关联时保存的原文摘录快照。
        </div>
      )}

      <div className="me-foot">
        <span className="me-time">关联于 {fmtTime(ev.created_at)}</span>
        <button
          type="button"
          disabled={ev.state === 'missing'}
          title={
            ev.state === 'missing'
              ? '原标注已删除，无法定位'
              : '切回正文并闪烁定位该标注当前位置'
          }
          onClick={() => onLocate(ev)}
        >
          定位正文
        </button>
      </div>
    </li>
  )
}

/**
 * 分析备忘录视图。
 *
 * 左列按时间列出当前文档的备忘录（在办 / 已归档两个分区），右列为编辑器：
 * 标题 + 正文可随时保存；「关联证据」勾选本篇已有标注，保存关联时后端对
 * 标注与原文摘录做快照，之后标注被修改或删除，证据仍保留快照并明确标示
 * 「已变化 / 已删除」。在办备忘录可归档，归档后只读，可恢复或永久删除。
 * 已保存的备忘录（含已归档）可通过「下载 Markdown」导出单条备忘录，
 * 导出由后端完成：正文保留原文，证据含快照与当前有效 / 已变化 / 已删除状态。
 */
export default function MemoView({
  docId,
  memos,
  loading,
  error,
  codings,
  onCreate,
  onUpdate,
  onDelete,
  onAddEvidence,
  onRemoveEvidence,
  onLocate,
}) {
  const [tab, setTab] = useState('active') // active | archived
  const [selectedId, setSelectedId] = useState(null)
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [composer, setComposer] = useState(false)
  const [saving, setSaving] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [picked, setPicked] = useState(() => new Set())
  const [busyEvidence, setBusyEvidence] = useState(null)

  const list = memos?.[tab] ?? null
  const selected = useMemo(
    () => (list ?? []).find((m) => m.id === selectedId) ?? null,
    [list, selectedId]
  )
  const archived = selected?.status === 'archived'

  // 列表加载 / 切换分区后修正选中项：保留仍存在的选中，否则默认选最新一条
  useEffect(() => {
    if (!list) return
    if (composer) return
    if (list.some((m) => m.id === selectedId)) return
    setSelectedId(list.length > 0 ? list[0].id : null)
  }, [list, selectedId, composer])

  // 选中备忘录后同步编辑器（保存后后端回传新值，未编辑的字段随之刷新）
  useEffect(() => {
    if (selected) {
      setTitle(selected.title)
      setBody(selected.body)
    }
  }, [selected?.id, selected?.title, selected?.body])

  const linkedIds = useMemo(
    () => new Set((selected?.evidences ?? []).map((e) => e.coding_id).filter((v) => v != null)),
    [selected]
  )
  const available = useMemo(
    () => codings.filter((c) => !linkedIds.has(c.id)),
    [codings, linkedIds]
  )

  const dirty =
    selected != null && (title !== selected.title || body !== selected.body)
  const titleBlank = title.trim() === ''

  async function guard(fn) {
    setSaving(true)
    try {
      await fn()
    } catch {
      /* 错误已由上层提示，保留本地草稿便于重试 */
    } finally {
      setSaving(false)
    }
  }

  function startNew() {
    setComposer(true)
    setSelectedId(null)
    setTitle('')
    setBody('')
    setPickerOpen(false)
    setPicked(new Set())
  }

  function cancelNew() {
    setComposer(false)
    setTitle(selected?.title ?? '')
    setBody(selected?.body ?? '')
    setPicked(new Set())
  }

  async function createMemo() {
    if (titleBlank) return
    await guard(async () => {
      const created = await onCreate({
        title: title.trim(),
        body,
        coding_ids: [...picked],
      })
      setComposer(false)
      setPicked(new Set())
      setPickerOpen(false)
      setTab('active')
      setSelectedId(created.id)
    })
  }

  async function saveEdits() {
    if (!selected || titleBlank || !dirty) return
    await guard(() => onUpdate(selected.id, { title: title.trim(), body }))
  }

  async function archive() {
    if (!selected) return
    if (!window.confirm(`归档备忘录「${selected.title}」？归档后将转为只读，可随时恢复。`)) return
    await guard(() => onUpdate(selected.id, { status: 'archived' }))
  }

  async function unarchive() {
    if (!selected) return
    await guard(() => onUpdate(selected.id, { status: 'active' }))
    setTab('active')
  }

  async function remove() {
    if (!selected) return
    if (!window.confirm(`永久删除备忘录「${selected.title}」及其全部证据关联？此操作不可恢复。`)) return
    await guard(async () => {
      await onDelete(selected.id)
      setSelectedId(null)
    })
  }

  function togglePick(id) {
    setPicked((cur) => {
      const next = new Set(cur)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function setMany(ids, on) {
    setPicked((cur) => {
      const next = new Set(cur)
      for (const id of ids) {
        if (on) next.add(id)
        else next.delete(id)
      }
      return next
    })
  }

  async function attachEvidence() {
    if (!selected || picked.size === 0) return
    const ids = [...picked]
    await guard(async () => {
      await onAddEvidence(selected.id, ids)
      setPicked(new Set())
      setPickerOpen(false)
    })
  }

  async function detach(ev) {
    if (!selected) return
    if (!window.confirm('移除该证据关联？原标注不受影响，保存的摘录快照将一并删除。')) return
    setBusyEvidence(ev.id)
    try {
      await onRemoveEvidence(selected.id, ev.id)
    } finally {
      setBusyEvidence(null)
    }
  }

  const evidences = selected?.evidences ?? []
  const changedCount = evidences.filter((e) => e.state !== 'current').length

  return (
    <div className="mv-panel">
      <div className="mv-layout">
        {/* ---------- 左：备忘录列表 ---------- */}
        <div className="mv-list-pane">
          <div className="mv-list-head">
            <div className="mv-tabs" role="tablist">
              {TABS.map(([key, label]) => (
                <button
                  key={key}
                  role="tab"
                  aria-selected={tab === key}
                  className={tab === key ? 'active' : ''}
                  onClick={() => setTab(key)}
                >
                  {label}
                </button>
              ))}
            </div>
            <button type="button" className="primary-btn" onClick={startNew}>
              ＋ 新建
            </button>
          </div>

          {loading && <div className="cooc-status">备忘录加载中…</div>}
          {!loading && error && <div className="cooc-status error">{error}</div>}
          {!loading && !error && list && list.length === 0 && (
            <div className="cooc-status">
              {tab === 'active'
                ? '还没有在办备忘录，点击「新建」开始记录分析想法。'
                : '暂无已归档备忘录。'}
            </div>
          )}

          {!loading && !error && list && list.length > 0 && (
            <ul className="mv-list">
              {list.map((m) => {
                const nChanged = m.evidences.filter((e) => e.state !== 'current').length
                return (
                  <li key={m.id}>
                    <button
                      type="button"
                      className={
                        !composer && selectedId === m.id ? 'mv-item active' : 'mv-item'
                      }
                      onClick={() => {
                        setComposer(false)
                        setSelectedId(m.id)
                      }}
                    >
                      <span className="mv-item-title">{m.title}</span>
                      <span className="mv-item-preview">{excerpt(m.body) || '（无正文）'}</span>
                      <span className="mv-item-meta">
                        {tab === 'archived'
                          ? `归档于 ${fmtTime(m.archived_at)}`
                          : `更新于 ${fmtTime(m.updated_at)}`}
                        {' · '}
                        {m.evidences.length} 条证据
                        {nChanged > 0 && (
                          <em className="mv-warn">（{nChanged} 条已变化/删除）</em>
                        )}
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>

        {/* ---------- 右：编辑器 / 新建表单 ---------- */}
        <div className="mv-editor-pane">
          {!selected && !composer && (
            <div className="cooc-status">
              选择左侧备忘录查看与编辑，或点击「新建」创建备忘录。
            </div>
          )}

          {(selected || composer) && (
            <div className="mv-editor">
              <input
                className="mv-title-input"
                placeholder="备忘录标题"
                value={title}
                disabled={archived}
                onChange={(e) => setTitle(e.target.value)}
              />

              {selected && (
                <div className="mv-meta-line">
                  {archived ? (
                    <>
                      <span className="me-state me-missing">已归档</span>
                      归档于 {fmtTime(selected.archived_at)}
                    </>
                  ) : null}
                  <span>创建于 {fmtTime(selected.created_at)}</span>
                  <span>更新于 {fmtTime(selected.updated_at)}</span>
                  <a
                    className="btn mv-download"
                    href={api.memoExportUrl(docId, selected.id)}
                    download
                    title="下载本条备忘录的 Markdown 文件：正文保留原文，证据含快照与当前状态"
                  >
                    下载 Markdown
                  </a>
                </div>
              )}

              <textarea
                className="mv-body"
                placeholder="记录分析想法：编码之间的关系、浮现的主题、待验证的假设……"
                rows={composer ? 12 : 10}
                value={body}
                disabled={archived}
                onChange={(e) => setBody(e.target.value)}
              />

              {composer && (
                <div className="mv-picker">
                  <button
                    type="button"
                    className="mv-picker-toggle"
                    onClick={() => setPickerOpen((v) => !v)}
                  >
                    {pickerOpen ? '收起证据选择' : `关联证据（${picked.size} 条待关联）`}
                  </button>
                  {pickerOpen && (
                    <EvidencePicker
                      available={available}
                      picked={picked}
                      onToggle={togglePick}
                      onSetMany={setMany}
                    />
                  )}
                </div>
              )}

              {/* ---------- 证据区（已保存的备忘录） ---------- */}
              {selected && (
                <div className="mv-evidences">
                  <div className="mv-ev-head">
                    <h5>
                      关联证据（{evidences.length}）
                      {changedCount > 0 && (
                        <em className="mv-warn">
                          {' '}· {changedCount} 条原标注已变化或删除，展示的是关联时快照
                        </em>
                      )}
                    </h5>
                    {!archived && (
                      <button
                        type="button"
                        onClick={() => {
                          setPickerOpen((v) => !v)
                          setPicked(new Set())
                        }}
                      >
                        {pickerOpen ? '收起' : '＋ 关联已有标注'}
                      </button>
                    )}
                  </div>

                  {pickerOpen && !archived && (
                    <div className="mv-picker">
                      <EvidencePicker
                        available={available}
                        picked={picked}
                        onToggle={togglePick}
                        onSetMany={setMany}
                      />
                      <div className="mv-picker-actions">
                        <button
                          type="button"
                          className="primary-btn"
                          disabled={picked.size === 0 || saving}
                          onClick={attachEvidence}
                        >
                          {saving ? '保存中…' : `关联所选 ${picked.size || ''} 条标注`}
                        </button>
                        <span className="hint">
                          关联时保存标注的编码、区间与原文摘录快照；之后标注被修改或删除，证据仍保留。
                        </span>
                      </div>
                    </div>
                  )}

                  {evidences.length === 0 ? (
                    <div className="cooc-status subtle">
                      尚未关联证据。可在正文中完成编码后，点击「关联已有标注」选择本篇标注作为论据。
                    </div>
                  ) : (
                    <ul className="me-list">
                      {evidences.map((ev) => (
                        <EvidenceCard
                          key={ev.id}
                          ev={ev}
                          archived={archived}
                          onRemove={detach}
                          onLocate={onLocate}
                        />
                      ))}
                    </ul>
                  )}
                  {busyEvidence && <div className="cooc-status subtle">更新证据中…</div>}
                </div>
              )}

              {/* ---------- 操作区 ---------- */}
              <div className="mv-actions">
                {composer ? (
                  <>
                    <button
                      type="button"
                      className="primary-btn"
                      disabled={saving || titleBlank}
                      onClick={createMemo}
                    >
                      {saving ? '创建中…' : '创建备忘录'}
                    </button>
                    <button type="button" onClick={cancelNew} disabled={saving}>
                      取消
                    </button>
                    {titleBlank && <span className="hint">标题不能为空</span>}
                  </>
                ) : archived ? (
                  <>
                    <button type="button" onClick={unarchive} disabled={saving}>
                      恢复为在办
                    </button>
                    <button
                      type="button"
                      className="mv-danger"
                      onClick={remove}
                      disabled={saving}
                    >
                      永久删除
                    </button>
                    <span className="hint">归档备忘录为只读，恢复后可继续编辑。</span>
                  </>
                ) : (
                  <>
                    <button
                      type="button"
                      className="primary-btn"
                      onClick={saveEdits}
                      disabled={saving || !dirty || titleBlank}
                    >
                      {saving ? '保存中…' : '保存修改'}
                    </button>
                    <button type="button" onClick={archive} disabled={saving}>
                      归档
                    </button>
                    <button
                      type="button"
                      className="mv-danger"
                      onClick={remove}
                      disabled={saving}
                    >
                      删除
                    </button>
                    {dirty && !titleBlank && <span className="hint">有未保存的修改</span>}
                    {titleBlank && <span className="hint">标题不能为空</span>}
                  </>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/** 勾选本篇尚未关联的已有标注作为证据 */
function EvidencePicker({ available, picked, onToggle, onSetMany }) {
  const [codeFilter, setCodeFilter] = useState(null) // null=全部编码
  const shown =
    codeFilter == null ? available : available.filter((c) => c.code_id === codeFilter)
  const codeById = {}
  for (const c of available) codeById[c.code_id] = c.code_name
  const allShownChecked = shown.length > 0 && shown.every((c) => picked.has(c.id))
  return (
    <div className="mv-picker-body">
      <div className="mv-picker-bar">
        <label>
          <input
            type="checkbox"
            checked={allShownChecked}
            onChange={(e) => onSetMany(shown.map((c) => c.id), e.target.checked)}
          />
          全选当前列表
        </label>
        <select
          value={codeFilter ?? ''}
          onChange={(e) => setCodeFilter(e.target.value === '' ? null : Number(e.target.value))}
        >
          <option value="">全部编码</option>
          {Object.entries(codeById).map(([id, name]) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </select>
        <span className="match-stat">{available.length} 条可关联</span>
      </div>
      {shown.length === 0 ? (
        <div className="cooc-status subtle">
          {available.length === 0 ? '本篇标注已全部关联（或还没有标注）。' : '该编码下没有可关联的标注。'}
        </div>
      ) : (
        <ul className="mv-candidate-list">
          {shown.map((c) => (
            <li key={c.id} className={picked.has(c.id) ? 'picked' : ''}>
              <label>
                <input
                  type="checkbox"
                  checked={picked.has(c.id)}
                  onChange={() => onToggle(c.id)}
                />
                <span className="dot" style={{ background: c.code_color }} />
                <code>[{c.start}, {c.end})</code>
                <span className="mv-cand-text" title={c.text}>{c.text}</span>
              </label>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

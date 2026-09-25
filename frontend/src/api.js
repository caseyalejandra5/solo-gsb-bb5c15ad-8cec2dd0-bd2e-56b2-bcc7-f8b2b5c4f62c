const BASE = '/api'

async function request(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  })
  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`
    try {
      const body = await res.json()
      if (body.detail) {
        if (typeof body.detail === 'string') {
          detail = body.detail
        } else {
          // 结构化错误（如迁移过期）：优先展示其中的 message，并保留原始
          // detail 供调用方按 code / reasons 做程序化处理
          detail = body.detail.message || JSON.stringify(body.detail)
          const err = new Error(detail)
          err.detail = body.detail
          throw err
        }
      }
    } catch (e) {
      if (e && e.detail) throw e
      /* 响应体不是 JSON：保留 HTTP 状态行作为错误信息 */
    }
    throw new Error(detail)
  }
  if (res.status === 204) return null
  return res.json()
}

export const api = {
  listDocuments: () => request('/documents'),
  createDocument: (title, content) =>
    request('/documents', { method: 'POST', body: JSON.stringify({ title, content }) }),
  getDocument: (id) => request(`/documents/${id}`),
  deleteDocument: (id) => request(`/documents/${id}`, { method: 'DELETE' }),
  searchDocument: (id, query) =>
    request(`/documents/${id}/search?query=${encodeURIComponent(query)}`),
  getCooccurrence: (id, codeIds = null) => {
    const qs = codeIds && codeIds.length ? `?${codeIds.map((c) => `codes=${c}`).join('&')}` : ''
    return request(`/documents/${id}/cooccurrence${qs}`)
  },
  // codeIds：null=全部编码；[]=不统计编码（仅文本长度）；否则逗号分隔
  getSpeakerStats: (id, codeIds = null) => {
    if (codeIds === null) return request(`/documents/${id}/speakers`)
    return request(`/documents/${id}/speakers?codes=${codeIds.join(',')}`)
  },
  // 跨文档编码分布对比；codeIds：null=全部编码；[]=不统计任何编码
  getCodeDistribution: (codeIds = null) => {
    if (codeIds === null) return request('/code-distribution')
    return request(`/code-distribution?codes=${codeIds.join(',')}`)
  },
  // 覆盖缺口；codeIds：null=全部编码；[]=不统计任何编码（全文即一个缺口）
  getGaps: (id, codeIds = null) => {
    if (codeIds === null) return request(`/documents/${id}/gaps`)
    return request(`/documents/${id}/gaps?codes=${codeIds.join(',')}`)
  },
  // 编码流转；codeIds：null=全部编码；[]=不统计任何编码（无状态区间与转移）
  getTransitions: (id, codeIds = null) => {
    if (codeIds === null) return request(`/documents/${id}/transitions`)
    return request(`/documents/${id}/transitions?codes=${codeIds.join(',')}`)
  },

  listCodes: () => request('/codes'),
  createCode: (name, color) =>
    request('/codes', { method: 'POST', body: JSON.stringify({ name, color }) }),
  updateCode: (id, patch) =>
    request(`/codes/${id}`, { method: 'PUT', body: JSON.stringify(patch) }),
  deleteCode: (id) => request(`/codes/${id}`, { method: 'DELETE' }),

  previewCoding: (payload) =>
    request('/codings/preview', { method: 'POST', body: JSON.stringify(payload) }),
  createCoding: (payload) =>
    request('/codings', { method: 'POST', body: JSON.stringify(payload) }),
  batchCreateCodings: (payload) =>
    request('/codings/batch', { method: 'POST', body: JSON.stringify(payload) }),
  // 标注包导入：预检（不落库）/ 确认（单事务写入）
  previewImport: (id, pkg) =>
    request(`/documents/${id}/import/preview`, {
      method: 'POST',
      body: JSON.stringify({ package: pkg }),
    }),
  confirmImport: (id, pkg) =>
    request(`/documents/${id}/import`, {
      method: 'POST',
      body: JSON.stringify({ package: pkg }),
    }),
  // 文档版本迁移：预检（不落库）/ 确认（校验原文版本，单事务更新正文与标注）
  previewMigration: (id, newContent) =>
    request(`/documents/${id}/migration/preview`, {
      method: 'POST',
      body: JSON.stringify({ new_content: newContent }),
    }),
  commitMigration: (id, payload) =>
    request(`/documents/${id}/migration/commit`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  // 标注抽样复核：获取批次（无批次返回 {batch: null}）/ 生成（替换旧批次）/ 删除
  getReview: (id) => request(`/documents/${id}/review`),
  createReview: (id, codes) =>
    request(`/documents/${id}/review`, {
      method: 'POST',
      body: JSON.stringify({ codes }),
    }),
  deleteReview: (id) =>
    request(`/documents/${id}/review`, { method: 'DELETE' }),
  // 标记单条复核结论：status = pending | approved | revision
  updateReviewItem: (docId, itemId, status, note) =>
    request(`/documents/${docId}/review/items/${itemId}`, {
      method: 'PATCH',
      body: JSON.stringify({ status, note }),
    }),

  // 分析备忘录：列表（status: active | archived | all）/ 新建 / 编辑或归档 / 删除
  listMemos: (docId, status = 'active') =>
    request(`/documents/${docId}/memos?status=${status}`),
  createMemo: (docId, { title, body = '', coding_ids = [] }) =>
    request(`/documents/${docId}/memos`, {
      method: 'POST',
      body: JSON.stringify({ title, body, coding_ids }),
    }),
  updateMemo: (docId, memoId, patch) =>
    request(`/documents/${docId}/memos/${memoId}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  deleteMemo: (docId, memoId) =>
    request(`/documents/${docId}/memos/${memoId}`, { method: 'DELETE' }),
  // 追加 / 移除证据（关联时后端保存标注与原文摘录快照）
  addMemoEvidence: (docId, memoId, codingIds) =>
    request(`/documents/${docId}/memos/${memoId}/evidences`, {
      method: 'POST',
      body: JSON.stringify({ coding_ids: codingIds }),
    }),
  removeMemoEvidence: (docId, memoId, evidenceId) =>
    request(
      `/documents/${docId}/memos/${memoId}/evidences/${evidenceId}`,
      { method: 'DELETE' }
    ),
  // 单条备忘录 Markdown 下载地址（正文 + 证据快照及当前状态）
  memoExportUrl: (docId, memoId) =>
    `${BASE}/documents/${docId}/memos/${memoId}/export`,
  updateCoding: (id, payload) =>
    request(`/codings/${id}`, { method: 'PUT', body: JSON.stringify(payload) }),
  deleteCoding: (id) => request(`/codings/${id}`, { method: 'DELETE' }),

  exportUrl: (docId) => `${BASE}/documents/${docId}/export`,
}

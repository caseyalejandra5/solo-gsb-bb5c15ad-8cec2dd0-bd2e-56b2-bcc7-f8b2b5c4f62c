import { useCallback, useEffect, useRef } from 'react'

/**
 * 异步错位守卫：文档切换场景下的「当前文档 + 请求次序」双重校验。
 *
 * useRequestTickets：为某类请求维护单调递增序号。每次发起请求前 begin()
 * 取号，响应落地前用 isLatest(seq) 判断是否仍是最新一次——切文档、连续
 * 刷新等场景下发的旧请求，其迟到响应一律丢弃，不得写入界面状态。
 *
 * useDocFreshness：实时跟踪当前文档 id（ref 同步，await 之后读到的仍是
 * 最新值）。响应落地前用 isCurrent(id) 校验该响应属于当前文档——即使
 * 请求序号仍是最新（如切换瞬间旧文档的 refresh 先于新文档请求发出），
 * 跨文档的响应也不会被应用。
 *
 * 返回的函数均经 useCallback 固定引用，可安全放入其它 hook 的依赖数组。
 */
export function useRequestTickets() {
  const seqRef = useRef(0)
  const begin = useCallback(() => ++seqRef.current, [])
  const isLatest = useCallback((seq) => seq === seqRef.current, [])
  return { begin, isLatest }
}

export function useDocFreshness(docId) {
  const docIdRef = useRef(docId)
  useEffect(() => {
    docIdRef.current = docId
  }, [docId])
  const isCurrent = useCallback((id) => id === docIdRef.current, [])
  return { docIdRef, isCurrent }
}

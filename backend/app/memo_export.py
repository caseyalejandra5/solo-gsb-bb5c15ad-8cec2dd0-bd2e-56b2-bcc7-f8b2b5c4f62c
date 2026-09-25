"""分析备忘录 Markdown 导出：把单条备忘录及其证据快照渲染为结构安全的 Markdown。

用户内容（标题、正文、编码名、原文摘录）可能包含任意字符（标题井号、
代码围栏、表格竖线、换行等），渲染时一律经过转义或放入动态长度的代码
围栏中，保证用户内容只能作为文本出现，不会伪造或破坏文档结构。
"""

from __future__ import annotations

STATE_LABELS = {
    "current": "当前有效",
    "changed": "已变化",
    "missing": "已删除",
}


def md_inline(value) -> str:
    """转义用户内容，使其可安全放在同一行的行内文本中。

    反斜杠、反引号与表格竖线加反斜杠转义；换行（含 CRLF 的 \\r）写成
    字面量 ``\\n``，保证用户内容不会另起一行，伪造标题、列表、表格或
    代码围栏等块级结构。原文本除 Markdown 结构性字符外不做任何改写。
    """
    out: list[str] = []
    for ch in str(value):
        if ch == "\\":
            out.append("\\\\")
        elif ch == "`":
            out.append("\\`")
        elif ch == "|":
            out.append("\\|")
        elif ch == "\n":
            out.append("\\n")
        elif ch == "\r":
            # 归一化 CRLF / CR：回车本身不保留为可见的字面量
            continue
        else:
            out.append(ch)
    return "".join(out)


def md_fenced(text: str) -> str:
    """把任意原文包进代码围栏并原样返回，长度按内容动态加长。

    围栏反引号数量始终比正文中出现过的最长反引号串多一个，因此正文里
    的 ``` / ```` 等（即便出现在行首）都不可能提前闭合围栏。围栏的开、
    闭行都独占一行：开围栏后固定补一个结构换行，故原文自带的前导换行
    （前导空行）逐字符保留；原文末尾再补一个换行后才是闭围栏，保证闭
    围栏始终位于独立行。内容不做转义或截断——空字符串得到一个空代码
    块。

    最长反引号串只对原文做一次线性扫描即可得到，围栏长度与渲染耗时均
    随原文长度线性增长，不会因长连续反引号反复扫描全文。
    """
    source = str(text)
    longest = 0
    run = 0
    for ch in source:
        if ch == "`":
            run += 1
            if run > longest:
                longest = run
        else:
            run = 0
    # 围栏至少 3 个反引号（代码围栏的最小长度）；含更长反引号串时再加长
    fence = "`" * max(3, longest + 1)
    return f"{fence}\n{source}\n{fence}"


def fmt_stamp(stamp) -> str:
    """SQLite datetime('now') 存的是 UTC 时间 "YYYY-MM-DD HH:MM:SS"。"""
    if not stamp:
        return "—"
    s = str(stamp)
    return f"{s} UTC" if "T" not in s else s


def render_memo_markdown(memo: dict, doc_title: str, exported_at: str) -> str:
    """渲染单条备忘录的 Markdown 导出文本。

    正文以代码围栏保留原文；证据逐条列出关联时保存的编码名、区间、摘录
    快照与当前状态（当前有效 / 已变化 / 已删除）；已变化时追加当前编码、
    区间与摘录，已删除时仅展示快照并明确说明，原快照不丢失。
    """
    if memo.get("status") == "archived":
        status_text = f"已归档（归档于 {fmt_stamp(memo.get('archived_at'))}）"
    else:
        status_text = "在办"

    evidences = memo.get("evidences", [])
    counts = {"current": 0, "changed": 0, "missing": 0}
    for ev in evidences:
        state = ev.get("state", "current")
        counts[state] = counts.get(state, 0) + 1

    lines: list[str] = [
        f"# {md_inline(memo.get('title', ''))}",
        "",
        f"- 所属文档：{md_inline(doc_title)}",
        f"- 备忘录状态：{status_text}",
        f"- 创建时间：{fmt_stamp(memo.get('created_at'))}",
        f"- 最近更新：{fmt_stamp(memo.get('updated_at'))}",
        f"- 导出时间：{exported_at}",
        (
            f"- 证据概况：共 {len(evidences)} 条（当前有效 {counts['current']} 条、"
            f"已变化 {counts['changed']} 条、已删除 {counts['missing']} 条）"
        ),
        "",
        "## 正文",
        "",
        # 正文保留原文：整体放入代码围栏，标题 / 围栏 / 表格字符均原样可见
        md_fenced(memo.get("body", "")),
        "",
        f"## 关联证据（{len(evidences)}）",
        "",
    ]
    if not evidences:
        lines.extend(["（无关联证据）", ""])

    for i, ev in enumerate(evidences, 1):
        state = ev.get("state", "current")
        state_label = STATE_LABELS.get(state, str(state))
        lines.extend(
            [
                (
                    f"### 证据 {i}：{md_inline(ev.get('code_name', ''))} "
                    f"`[{ev.get('start')}, {ev.get('end')})` · {state_label}"
                ),
                "",
                f"- 当前状态：{state_label}",
                f"- 关联时编码名：{md_inline(ev.get('code_name', ''))}",
                f"- 关联时区间：`[{ev.get('start')}, {ev.get('end')})`",
                f"- 关联时间：{fmt_stamp(ev.get('created_at'))}",
                "",
                "关联时保存的原文摘录（快照）：",
                "",
                md_fenced(ev.get("excerpt", "")),
                "",
            ]
        )
        cur = ev.get("current")
        if state == "changed" and cur:
            lines.extend(
                [
                    "该标注现已变化，当前信息如下：",
                    "",
                    f"- 当前编码名：{md_inline(cur.get('code_name', ''))}",
                    f"- 当前区间：`[{cur.get('start')}, {cur.get('end')})`",
                    "",
                    "当前原文摘录：",
                    "",
                    md_fenced(cur.get("excerpt", "")),
                    "",
                ]
            )
        elif state == "missing":
            lines.extend(
                [
                    "> 原标注已被删除。上面的编码名、区间与原文摘录是关联时保存的快照，未随删除丢失。",
                    "",
                ]
            )

    return "\n".join(lines)

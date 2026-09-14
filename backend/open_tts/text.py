"""Conservative text normalization and generation-unit packing.

Spoken content is not rewritten. Normalization only removes BOM/zero-width
artifacts, maps CRLF to LF, trims outer whitespace, and may join soft wraps
inside a paragraph with a single space. Paragraph gaps, list lines, and
punctuation stay intact. Packing never drops or reorders non-whitespace.
"""

from __future__ import annotations

import re
from typing import List

ZERO_WIDTH = dict.fromkeys(map(ord, "\u200b\ufeff"), None)

ABBREVIATIONS = frozenset({
    "dr", "mr", "mrs", "ms", "prof", "sr", "jr", "vs", "etc", "inc", "ltd",
    "st", "ave", "rd", "blvd", "dept", "univ", "est", "fig", "al", "eg", "ie",
    "no", "vol", "pp", "ch", "gen", "col", "lt", "sgt", "rev", "hon", "sen",
    "rep", "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept",
    "oct", "nov", "dec",
})

_LIST_LINE = re.compile(r"^\s*(?:[-*•]|\d+[.)])\s+")


def normalize_text(text: str) -> str:
    if text is None:
        return ""
    t = str(text).replace("\r\n", "\n").replace("\r", "\n")
    t = t.translate(ZERO_WIDTH)
    t = t.strip()
    if not t:
        return ""
    paragraphs = re.split(r"\n[ \t]*\n+", t)
    packed: List[str] = []
    for para in paragraphs:
        packed.append(_join_soft_wraps(para))
    return "\n\n".join(p for p in packed if p)


def _join_soft_wraps(para: str) -> str:
    lines = para.split("\n")
    if len(lines) == 1:
        return lines[0].strip() if not _LIST_LINE.match(lines[0]) else lines[0].rstrip()
    out: List[str] = []
    buf = ""
    for raw in lines:
        line = raw.strip()
        if _LIST_LINE.match(raw) or _LIST_LINE.match(line):
            if buf:
                out.append(buf)
                buf = ""
            out.append(line)
            continue
        if not line:
            continue
        if not buf:
            buf = line
        else:
            buf = f"{buf} {line}"
    if buf:
        out.append(buf)
    return "\n".join(out)


def sentence_units(text: str) -> List[str]:
    """Exact sentence-sized substrings of *text* (already normalized)."""
    if not text:
        return []
    units: List[str] = []
    start = 0
    i = 0
    n = len(text)
    while i < n:
        ch = text[i]
        if ch in ".!?" and _is_sentence_end(text, i):
            j = i + 1
            while j < n and text[j] in "\"'”’)]]":
                j += 1
            k = j
            while k < n and text[k].isspace() and text[k] != "\n":
                k += 1
            rest = text[k:] if k < n else ""
            nxt = next((c for c in rest if not c.isspace()), "")
            if nxt and nxt.islower():
                i += 1
                continue
            if k < n and text[k] == "\n":
                units.append(text[start:k])
                start = k
                i = k
            else:
                units.append(text[start:k])
                start = k
                i = k
            continue
        i += 1
    if start < n:
        units.append(text[start:])
    return units


def _word_before_period(text: str, i: int) -> str:
    k = i - 1
    while k >= 0 and text[k].isalpha():
        k -= 1
    return text[k + 1 : i]


def _is_sentence_end(text: str, i: int) -> bool:
    ch = text[i]
    n = len(text)
    if ch == ".":
        if i > 0 and text[i - 1].isdigit() and i + 1 < n and text[i + 1].isdigit():
            return False
        word = _word_before_period(text, i).lower()
        if word in ABBREVIATIONS:
            return False
        if len(word) == 1:
            return False
        lookback = text[max(0, i - 12) : i].lower()
        if "www." in lookback or "://" in text[max(0, i - 32) : i]:
            if i + 1 < n and not text[i + 1].isspace():
                return False
    nxt = text[i + 1] if i + 1 < n else ""
    if nxt == "" or nxt.isspace() or nxt in "\"'”’)]]":
        return True
    return False


def hard_split(text: str, max_chars: int) -> List[str]:
    """Split *text* at max_chars without dropping characters.

    Prefers paragraph, then sentence, then space boundaries. A single token
    longer than the cap is cut hard so the payload cap cannot be bypassed.
    """
    if not text:
        return []
    if max_chars <= 0:
        raise ValueError("max_chars must be positive")
    if len(text) <= max_chars:
        return [text]
    parts: List[str] = []
    remaining = text
    while remaining:
        if len(remaining) <= max_chars:
            parts.append(remaining)
            break
        window = remaining[:max_chars]
        split_at = window.rfind("\n\n")
        if split_at < max_chars // 4:
            split_at = -1
            for i in range(len(window) - 1, max_chars // 4, -1):
                if window[i - 1] in ".!?" and window[i].isspace():
                    split_at = i
                    break
            if split_at < 0:
                split_at = window.rfind(" ")
                if split_at < max_chars // 4:
                    split_at = max_chars
        if split_at <= 0:
            split_at = max_chars
        parts.append(remaining[:split_at])
        remaining = remaining[split_at:]
    return parts


def pack_generation_units(text: str, first_max: int, rest_max: int) -> List[str]:
    """Pack sentences into generate units.

    Only the first unit uses *first_max*. Everything after is packed at
    *rest_max*. A sentence is hard-split only when it exceeds the active cap.
    """
    if not text:
        return []
    if first_max <= 0 or rest_max <= 0:
        raise ValueError("generation unit caps must be positive")
    sentences = sentence_units(text)
    if not sentences:
        return hard_split(text, rest_max) if len(text) > rest_max else [text]

    out: List[str] = []
    buf = ""
    first_open = True

    def limit() -> int:
        return first_max if first_open and not out else rest_max

    def commit() -> None:
        nonlocal buf, first_open
        if buf:
            out.append(buf)
            buf = ""
            first_open = False

    for sent in sentences:
        cap = limit()
        if not buf:
            if len(sent) <= cap:
                buf = sent
                continue
            pieces = hard_split(sent, cap)
            if first_open:
                out.append(pieces[0])
                first_open = False
                for piece in pieces[1:]:
                    if len(piece) > rest_max:
                        hard = hard_split(piece, rest_max)
                        if buf:
                            out.append(buf)
                        out.extend(hard[:-1])
                        buf = hard[-1]
                    elif buf and len(buf) + len(piece) <= rest_max:
                        buf += piece
                    else:
                        if buf:
                            out.append(buf)
                        buf = piece
            else:
                out.extend(pieces[:-1])
                buf = pieces[-1]
            continue
        if len(buf) + len(sent) <= cap:
            buf += sent
        else:
            commit()
            if len(sent) <= rest_max:
                buf = sent
            else:
                pieces = hard_split(sent, rest_max)
                out.extend(pieces[:-1])
                buf = pieces[-1]
    if buf:
        out.append(buf)
    return out


def non_whitespace_key(text: str) -> str:
    return "".join(ch for ch in text if not ch.isspace())

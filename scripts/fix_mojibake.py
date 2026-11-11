"""修复 client/**/*.ts 的 GBK 误读污染(含字节截断的暴力补全)。

两种损伤形态:
  1. 完整损伤:UTF-8 字节被按 GBK 解释 → 逐字符 encode('gbk') 即可拿回原字节。
  2. 截断损伤:还原过程中末尾少一个字节,被替换成 '?'。此时把 '?' 之前的片段
     encode('gbk') 得到 k 字节,再枚举第 k+1 个字节 0x00..0xFF,取第一个能
     成功 UTF-8 解码且落在 CJK/标点区的组合 —— 这是无损还原。

只在「还原后不再有 mojibake 痕迹」时写回,避免误伤正确中文。
"""

from __future__ import annotations

import glob
import os
import re
import sys

MOJI_CHARS = set(
    "涓鍜鐢鏄濡鍩鎴闃瀹浣鍑鏂鐨鏃鍙鐜鎬瑙璁鏇鍏鍚杩堢绁搴鎵鐭鍒鍐閿鑳鍔鐗鏆璺"
    "璇ュ摢鏋佸叾绉嶇被锛銆鈥镐簨鍟婂暒鍛㈠彲"
)
MOJI_RE = re.compile("[" + "".join(sorted(MOJI_CHARS)) + "]")


def moji_score(text: str) -> int:
    n = len(MOJI_RE.findall(text))
    n += text.count("锛") + text.count("銆") + text.count("鈥")
    return n


def try_decode(bytez: bytes) -> str | None:
    try:
        return bytez.decode("utf-8")
    except UnicodeDecodeError:
        return None


def complete_truncated(prefix: str) -> str | None:
    """prefix 以 mojibake 结尾且末字节丢失。枚举补齐字节。"""
    try:
        head = prefix.encode("gbk")
    except UnicodeEncodeError:
        return None
    for b in range(0x80, 0x100):
        got = try_decode(head + bytes([b]))
        if got is None:
            continue
        ch = got
        if len(ch) == 1:
            return ch
    return None


# 形如 <mojibake>?  其中 ? 是丢失字节的占位
TRUNC_RE = re.compile(
    "([" + "".join(sorted(MOJI_CHARS)) + "]{1,8})\\?"
)


def repair_truncations(line: str) -> tuple[str, int]:
    """把 `<moji>?` 还原成正确中文。返回 (新行, 修复次数)。"""
    fixed = 0

    def sub(m: re.Match[str]) -> str:
        nonlocal fixed
        prefix = m.group(1)
        ch = complete_truncated(prefix)
        if ch is not None:
            fixed += 1
            return ch
        return m.group(0)

    out = TRUNC_RE.sub(sub, line)
    return out, fixed


def repair_full_line(line: str) -> str | None:
    try:
        return line.encode("gbk").decode("utf-8")
    except (UnicodeEncodeError, UnicodeDecodeError):
        return None


def repair_line(line: str) -> tuple[str, int]:
    """先补截断,再整体还原。"""
    line, n = repair_truncations(line)
    if moji_score(line) > 0:
        rep = repair_full_line(line)
        if rep is not None and moji_score(rep) < moji_score(line):
            line = rep
            n += 1
    return line, n


def main() -> int:
    root = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
    targets = sorted(
        set(glob.glob(os.path.join(root, "client", "**", "*.ts"), recursive=True))
        | set(glob.glob(os.path.join(root, "server", "**", "*.ts"), recursive=True))
        | set(glob.glob(os.path.join(root, "tests", "*.ts"), recursive=True))
        | set(glob.glob(os.path.join(root, "docs", "*.md"), recursive=True))
    )
    files_fixed = 0
    lines_fixed = 0
    for path in targets:
        raw = open(path, "rb").read()
        text = try_decode(raw)
        if text is None:
            print("  SKIP (not utf-8): %s" % os.path.relpath(path, root))
            continue
        before = moji_score(text)
        if before == 0:
            continue
        lines = text.split("\n")
        n_here = 0
        for i, ln in enumerate(lines):
            new, n = repair_line(ln)
            if n > 0 and new != ln:
                lines[i] = new
                n_here += n
        fixed = "\n".join(lines)
        after = moji_score(fixed)
        rel = os.path.relpath(path, root).replace("\\", "/")
        if n_here > 0 and (after < before or "?" in text):
            with open(path, "w", encoding="utf-8", newline="") as fh:
                fh.write(fixed)
            print("  FIXED %s: score %d -> %d, repairs %d" % (rel, before, after, n_here))
            files_fixed += 1
            lines_fixed += n_here
        else:
            print("  KEEP  %s: score %d -> %d" % (rel, before, after))
    print("\nfiles fixed: %d / repairs: %d" % (files_fixed, lines_fixed))
    return 0


if __name__ == "__main__":
    sys.exit(main())

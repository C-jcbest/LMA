"""文档与提示词检查：本地链接有效、已删除的名称没有回流、常驻上下文不超长。

只用标准库，CI 与本机都用 `python ops/check_docs.py` 运行；有问题时逐条列出并以非零状态退出。
"""

import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

# 决策记录和验收报告保存的是历史，允许出现已删除的名称。
HISTORY_DIRECTORIES = ("docs/decisions/", "docs/reviews/")
RETIRED_TERMS_FILE = ROOT / "ops" / "retired-terms.txt"
# 本文件和名单本身必然包含这些名称。
RETIRED_TERM_EXEMPT = {"ops/retired-terms.txt", "ops/check_docs.py"}
# 已删除名称在现行文档、提示词和源码里都不应再出现。
RETIRED_TERM_SCOPES = (".md", ".py", ".ts", ".tsx", ".css", ".yml", ".example")

# 每次对话都会加载的指令文件和提示词，长度直接占用上下文；超出时先合并或删除旧规则，再加新的。
SIZE_LIMITS = {
    "AGENTS.md": ("lines", 100),
    "backend/AGENTS.md": ("lines", 40),
    "frontend/AGENTS.md": ("lines", 40),
    "backend/app/agent/prompts/AGENTS.md": ("lines", 40),
    "backend/app/agent/prompts/system.md": ("chars", 6000),
}

MARKDOWN_LINK = re.compile(r"\]\(([^)\s]+)\)")


def tracked_files() -> list[str]:
    output = subprocess.run(
        ["git", "ls-files", "--cached", "--others", "--exclude-standard"],
        cwd=ROOT, capture_output=True, text=True, encoding="utf-8", check=True,
    ).stdout
    return [line for line in output.splitlines() if line and (ROOT / line).is_file()]


def broken_links(files: list[str]) -> list[str]:
    problems = []
    for name in files:
        if not name.endswith(".md"):
            continue
        path = ROOT / name
        for target in MARKDOWN_LINK.findall(path.read_text(encoding="utf-8")):
            if re.match(r"^[a-z]+:", target) or target.startswith("#"):
                continue
            local = target.split("#", 1)[0]
            if local and not (path.parent / local).exists():
                problems.append(f"{name}: 链接指向不存在的文件 {target}")
    return problems


def retired_terms() -> list[tuple[str, str]]:
    terms = []
    for line in RETIRED_TERMS_FILE.read_text(encoding="utf-8").splitlines():
        if not line.strip() or line.startswith("#"):
            continue
        term, _, reason = line.partition("#")
        terms.append((term.strip(), reason.strip()))
    return terms


def retired_term_mentions(files: list[str]) -> list[str]:
    terms = retired_terms()
    problems = []
    for name in files:
        if name in RETIRED_TERM_EXEMPT or name.startswith(HISTORY_DIRECTORIES) or not name.endswith(RETIRED_TERM_SCOPES):
            continue
        text = (ROOT / name).read_text(encoding="utf-8", errors="ignore")
        for term, reason in terms:
            if term in text:
                problems.append(f"{name}: 出现已删除的“{term}”（{reason}）")
    return problems


def oversized_files() -> list[str]:
    problems = []
    for name, (unit, limit) in SIZE_LIMITS.items():
        path = ROOT / name
        if not path.exists():
            problems.append(f"{name}: 文件不存在，请同步更新 ops/check_docs.py 的长度上限")
            continue
        text = path.read_text(encoding="utf-8")
        size = len(text.splitlines()) if unit == "lines" else len(text)
        if size > limit:
            problems.append(f"{name}: {size} {unit} 超过上限 {limit}；先合并或删除旧内容再添加")
    return problems


def main() -> int:
    # Windows 控制台默认 GBK，中文提示会乱码。
    sys.stdout.reconfigure(encoding="utf-8")
    files = tracked_files()
    problems = broken_links(files) + retired_term_mentions(files) + oversized_files()
    for problem in problems:
        print(problem)
    if problems:
        print(f"\n文档检查未通过：{len(problems)} 项")
        return 1
    print("文档检查通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())

"""T0.3 源码摘录的离线检查：文件存在、注明版本、每节都有 `路径:行号` 出处。"""

import re
from pathlib import Path

import pytest

NOTES = Path(__file__).resolve().parent.parent / "docs/api-notes"

CASES = {
    "pipecat.md": ("Pipecat 1.12.0", r"[\w/]+\.py:\d+"),
    "deeptutor.md": ("DeepTutor v1.6.12", r"[\w./-]+\.(py|md|json|ya?ml|ts|tsx):\d+"),
}


@pytest.mark.parametrize("name", CASES)
def test_notes_header_names_locked_version(name):
    first = (NOTES / name).read_text(encoding="utf-8").splitlines()[0]
    assert CASES[name][0] in first


@pytest.mark.parametrize("name", CASES)
def test_every_section_cites_source_lines(name):
    text = (NOTES / name).read_text(encoding="utf-8")
    sections = re.split(r"^## ", text, flags=re.M)[1:]
    assert len(sections) >= 5
    for body in sections:
        title = body.splitlines()[0]
        if title.startswith("未验证"):
            continue
        assert re.search(CASES[name][1], body), f"{name} 的「{title}」没有 路径:行号 出处"

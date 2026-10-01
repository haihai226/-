"""T0.1 仓库骨架的离线检查。"""

import importlib
import re
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent

REQUIRED_ENV_VARS = [
    "STT_PROVIDER",
    "STT_API_KEY",
    "STT_BASE_URL",
    "TTS_PROVIDER",
    "TTS_API_KEY",
    "TTS_BASE_URL",
    "TTS_VOICE_ID",
    "LLM_API_KEY",
    "LLM_BASE_URL",
    "LLM_MODEL",
    "DEEPTUTOR_API_URL",
    "DEEPTUTOR_WEB_PORT",
    "DEEPTUTOR_API_PORT",
    "VOICE_AGENT_HOST",
    "VOICE_AGENT_PORT",
]


@pytest.mark.parametrize(
    "module",
    ["voice_agent", "adapter", "adapter.tools", "tests.fake_deeptutor", "tests.e2e"],
)
def test_packages_importable(module):
    importlib.import_module(module)


@pytest.mark.parametrize(
    "path",
    ["voice_agent/prompts", "web", "deeptutor", "scripts", "docs/api-notes", "vendor", "data/kb"],
)
def test_directories_exist(path):
    assert (ROOT / path).is_dir()


def _env_example() -> dict[str, str]:
    values = {}
    for line in (ROOT / ".env.example").read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        key, _, value = line.partition("=")
        values[key.strip()] = value.strip()
    return values


def test_env_example_lists_required_vars():
    missing = [k for k in REQUIRED_ENV_VARS if k not in _env_example()]
    assert missing == []


def test_env_example_has_no_secret_values():
    for key, value in _env_example().items():
        if key.endswith("_API_KEY"):
            assert value == "", f"{key} 在 .env.example 里必须留空"


def test_env_and_kb_pdfs_are_gitignored():
    lines = (ROOT / ".gitignore").read_text(encoding="utf-8").splitlines()
    assert ".env" in lines
    assert any(re.fullmatch(r"data/kb/\*(\.pdf)?", l) for l in lines)


def test_live_marker_registered(pytestconfig):
    markers = pytestconfig.getini("markers")
    assert any(m.startswith("live") for m in markers)


def test_progress_table_header():
    text = (ROOT / "docs/PROGRESS.md").read_text(encoding="utf-8")
    assert "| 日期 | 任务 | 分支 | 证据 | 未验证 |" in text

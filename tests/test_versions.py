"""T0.2 版本锁定的离线检查。"""

import re
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def _versions_md() -> str:
    return (ROOT / "docs/VERSIONS.md").read_text(encoding="utf-8")


def test_pipecat_pinned_to_minor_version():
    deps = tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))["project"]["dependencies"]
    pipecat = [d for d in deps if d.startswith("pipecat-ai")]
    assert len(pipecat) == 1
    assert re.search(r"~=\d+\.\d+\.\d+$", pipecat[0]), pipecat[0]


def test_pipecat_version_in_lock_matches_versions_md():
    lock = (ROOT / "uv.lock").read_text(encoding="utf-8")
    m = re.search(r'name = "pipecat-ai"\nversion = "([^"]+)"', lock)
    assert m
    assert f"pipecat-ai` | `{m.group(1)}`" in _versions_md()


def test_deeptutor_image_tag_pinned_and_documented():
    compose = (ROOT / "compose.yaml").read_text(encoding="utf-8")
    tags = re.findall(r"image:\s*ghcr\.io/hkuds/deeptutor:(\S+)", compose)
    assert tags, "compose.yaml 里没有 DeepTutor 镜像"
    for tag in tags:
        assert tag != "latest"
        assert f"ghcr.io/hkuds/deeptutor:{tag}" in _versions_md()


def test_deeptutor_submodule_registered():
    gitmodules = (ROOT / ".gitmodules").read_text(encoding="utf-8")
    assert "path = vendor/DeepTutor" in gitmodules
    assert "url = https://github.com/HKUDS/DeepTutor" in gitmodules


def test_published_ports_bound_to_localhost():
    compose = (ROOT / "compose.yaml").read_text(encoding="utf-8")
    for port in re.findall(r'^\s*-\s*"([^"]*:\d+)"\s*$', compose, re.M):
        assert port.startswith("127.0.0.1:"), port

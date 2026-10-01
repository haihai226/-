# 版本锁定

锁定日期：2026-10-01

| 组件 | 版本 | 锁在哪 |
| --- | --- | --- |
| `pipecat-ai` | `1.12.0` | `pyproject.toml`（`~=1.12.0`）+ `uv.lock` |
| DeepTutor 源码 | `v1.6.12`（commit `ef2d9e5c3c99`，2026-09-27） | `vendor/DeepTutor` submodule，只读 |
| DeepTutor 镜像 | `ghcr.io/hkuds/deeptutor:1.6.12` | `compose.yaml` |

`pipecat-ai` 的 extras：`silero`、`webrtc`、`qwen`、`runner`。
以 PyPI 上 1.12.0 的 `provides_extra` 元数据为准，见下面"extras 说明"。

## extras 说明

- `silero`：Silero VAD，依赖 `onnxruntime`。
- `webrtc`：`SmallWebRTCTransport`，依赖 `aiortc`。
- `qwen`：`pipecat/services/qwen/llm.py`，OpenAI 兼容接口。DeepSeek 备选不需要额外 extra（`pipecat/services/deepseek` 在核心包里）。
- `runner`：`fastapi`、`uvicorn`、`pipecat-ai-prebuilt`，用于起 WebRTC 信令服务和自带测试页面。
- MiniMax TTS：`pipecat/services/minimax/tts.py` 在核心包里，没有单独的 extra。
- FunASR：**未装**。Pipecat 的 `funasr` extra（`pipecat/services/funasr/stt.py:32` `from funasr import AutoModel`）是进程内跑模型的分段识别，会拉进 torch、modelscope、transformers；方案里 FunASR 是独立容器（端口 10095）。选哪种待定，见 PROGRESS.md。

## 升级流程

1. 新开分支 `task/upgrade-<组件>-<版本>`。
2. `pipecat-ai`：改 `pyproject.toml` 里的版本，`uv lock --upgrade-package pipecat-ai`，`uv sync`。
   DeepTutor：submodule `git checkout <新 tag>`，`compose.yaml` 改成同一个 tag（镜像 tag 不带 `v`）。
3. 重读 `docs/api-notes/` 里引用到的源码位置，行号或签名变了就更新摘录。
4. `uv run pytest` 全绿。
5. `uv run python scripts/smoke_10turns.py` 跑 10 轮回归，延迟 P50 / P95 不比升级前差。
6. 更新本文件的版本号和锁定日期，在 PROGRESS.md 记一行。

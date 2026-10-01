# Pipecat × DeepTutor 语音家教 — Claude 开工必读

## 目标

做一个能语音实时对话的 AI 家教：Pipecat 负责听和说，DeepTutor 负责教材、记忆和出题，两者通过"异步工具"衔接。
学生说完到听见回应 ≤ 1.2 s，教材查询在后台跑，对话不中断。

完整方案在 `docs/plan.md`，任务清单在 `docs/TASKS.md`。先把这两个文件读完再动手。

## 工作方式

1. 严格按 `docs/TASKS.md` 的顺序做，一次只做一个任务。
2. 每个任务：先给出计划 → 我批准 → 先写测试 → 再写实现 → 跑通 → 提交 → 在 `docs/PROGRESS.md` 追加一行。
3. 一个阶段的门槛（TASKS.md 里标 **Gate**）没过，不进入下一阶段。
4. 碰到下面"需要我的事"清单上的事项，停下来问我；其它决定自己做，把理由写进 PROGRESS.md。
5. 做不到或没验证的，如实写"未验证"，不要写"应该可以"。

## 硬规则

- 不改 Pipecat 和 DeepTutor 的源码；所有耦合只放在 `adapter/` 目录。
- 工具接口以 `adapter/contracts.py` 为准，改接口先问我。
- 不许用同步调用、sleep 或缩短超时来"修"延迟；延迟只能靠异步工具和预取解决。
- 不确定 Pipecat 的 API 时，读 `.venv` 里安装的源码或 https://docs.pipecat.ai/llms.txt ；不许凭记忆猜。
  DeepTutor 同理，读 `vendor/DeepTutor/`（只读 submodule）的源码和它根目录的 `SKILL.md`。
- 版本锁死：`pipecat-ai` 固定小版本写进 `uv.lock`，DeepTutor 固定镜像 tag 写进 compose；升级前跑 10 轮回归。
- 不加新依赖，除非在计划里写明原因并得到批准。
- 密钥只从 `.env` 读，`.env` 在 `.gitignore` 里；任何代码、日志、测试 fixture、提交信息里不得出现密钥。
- 测试必须离线可跑（用 `tests/fake_deeptutor/` 的回放服务器）；需要真实 API 的测试打 `live` 标记，CI 跳过。
- 一个任务一个分支，分支名形如 `task/T1-2-web-client`；提交信息用中文。

## 环境与命令

- Python 3.12 + uv。安装：`uv sync`
- 离线测试：`uv run pytest`　　需要密钥的测试：`uv run pytest -m live`
- 起 DeepTutor：`docker compose up deeptutor`，网页在 http://127.0.0.1:3782
- 起语音 agent：`uv run python -m voice_agent.bot`
- 10 轮脚本对话 + 延迟报告：`uv run python scripts/smoke_10turns.py`
- 日志在 `logs/`，延迟指标写到 `logs/latency.jsonl`

## 目录约定

```
voice_agent/   Pipecat 管道、系统提示（prompts/）、清洗处理器
adapter/       contracts.py、deeptutor_client.py、tools/、idle_queue.py、speakable.py、prefetch.py
web/           Pipecat 客户端页面 + 伴随面板
deeptutor/     compose 片段、settings 模板、partners/voice-tutor/SOUL.md、建库脚本
tests/         单元测试、tests/fake_deeptutor/ 回放服务器、tests/e2e/
scripts/       smoke_10turns.py、latency_report.py、build_kb.py、record_deeptutor_stream.py
docs/          plan.md、TASKS.md、PROGRESS.md、api-notes/
vendor/        DeepTutor 源码 submodule（只读）
data/kb/       教材 PDF（不提交）
```

## 需要我的事（只在这些事上停下来问）

1. `.env` 里的密钥：STT、TTS、LLM 的 key 和 base URL。
2. 教材 PDF 放到 `data/kb/`。
3. 阶段一结束：我戴耳机试听，确认音色、延迟、打断手感。
4. 阶段二：我审 `deeptutor/partners/voice-tutor/SOUL.md` 的教学风格。
5. 阶段三结束：我亲自试一次插话和换问题。
6. 阶段四：部署目标——哪台服务器、域名、要不要 TURN。

## 每个任务的交付证据

- 测试命令 + 结果摘要（通过/失败数）。
- 涉及延迟的任务：`logs/latency.jsonl` 算出的 P50 / P95。
- 明确列出"未验证"的部分和原因。
- `docs/PROGRESS.md` 追加一行：`日期 | 任务号 | 分支 | 证据 | 未验证`

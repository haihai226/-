# 进度

每完成一个任务追加一行。证据列写测试命令与结果、延迟 P50/P95；未验证列如实写。

| 日期 | 任务 | 分支 | 证据 | 未验证 |
| --- | --- | --- | --- | --- |
| 2026-10-01 | T0.1 | task/T0-1-skeleton | `uv sync && uv run pytest` 17 passed；`-m live` 0 个（17 deselected）；CI 绿（PR #1） | 无 |
| 2026-10-01 | T0.2 | task/T0-2-lock-versions | pipecat-ai 1.12.0（extras silero/webrtc/qwen/runner）写进 uv.lock；DeepTutor submodule v1.6.12，compose 镜像 1.6.12（ghcr 标签列表里已确认存在）；`uv run pytest` 22 passed | `docker compose pull deeptutor`：云端环境拉镜像层被网络策略拦截（pkg-containers.githubusercontent.com 403），需在本机验证。STT 的 extra 未装：Pipecat 的 funasr extra 是进程内模型（拉 torch），与方案里的独立 FunASR 容器不一致，待定 |
| 2026-10-01 | T0.3 | task/T0-3-api-notes | docs/api-notes/pipecat.md、deeptutor.md 每节带 路径:行号；`uv run pytest` 26 passed | 摘录只读源码，未运行：Qwen 关 thinking 的 extra_body 参数、Partner SSE 断开能否中止 turn、经 3782 转发时流是否被缓冲、Partner 记忆的实际落盘目录、前端 JS 收服务端消息的接口 |

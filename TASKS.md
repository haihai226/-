# 任务清单

按顺序做，一次一个。每个任务都有"做完的标准"；每个阶段末尾有 **Gate**，没过不进下一阶段。
标 **[需要我]** 的地方停下来问我，其它自己决定。

---

## 阶段 0 · 准备（预计 1 天）

### T0.1 仓库骨架
- `pyproject.toml`（uv，Python 3.12），目录按 CLAUDE.md 的约定建好，空模块各放一个 `__init__.py`
- `.env.example` 列出全部需要的变量（STT / TTS / LLM 的 key 与 base URL、DeepTutor 地址、端口），`.env` 加进 `.gitignore`
- `tests/conftest.py`，`pytest.ini` 定义 `live` 标记
- GitHub Actions：push 时跑 `uv run pytest`（离线测试），不跑 `live`
- `docs/PROGRESS.md` 建好表头
- 做完的标准：`uv sync && uv run pytest` 在空仓库上通过（0 个测试也算通过），CI 绿

### T0.2 锁版本
- `pipecat-ai` 装当前 PyPI 最新稳定小版本，带 extras：`silero`、`webrtc`、所选 STT/TTS/LLM 的 extra（以安装后的 `pyproject` 元数据为准，不要猜 extra 名）
- `git submodule add https://github.com/HKUDS/DeepTutor vendor/DeepTutor`，checkout 到当前最新 release tag，只读
- `docker compose` 里 DeepTutor 用 `ghcr.io/hkuds/deeptutor:<同一个 tag>`，不用 `latest`
- 写 `docs/VERSIONS.md`：两个版本号、锁定日期、升级流程（跑 10 轮回归）
- 做完的标准：`uv.lock` 提交；`docker compose pull deeptutor` 成功

### T0.3 源码摘录（防止猜 API）
- 读 `.venv` 里的 pipecat 源码，把以下内容的**真实签名和用法**摘到 `docs/api-notes/pipecat.md`：
  异步函数调用（`cancel_on_interruption`、中间更新的 `FunctionCallResultProperties(is_final=False)`、`enable_async_tool_cancellation`）、
  `SmallWebRTCTransport`、Silero VAD、所选 STT/TTS/LLM 服务类、上下文聚合器、指标/OpenTelemetry 开关、向客户端发自定义消息的方式
- 读 `vendor/DeepTutor`，把以下内容摘到 `docs/api-notes/deeptutor.md`：
  Partner 的 HTTP/SSE 接口（路径、鉴权、请求体、事件类型 `content / tool_call / tool_result / done`）、`deeptutor run chat --format json` 的 NDJSON 事件结构、
  session 的创建与复用、能否中止正在跑的 turn（找 Stop 的实现）、`data/user/settings/*.json` 中配置模型与 Partner 的字段、`SOUL.md` 的格式
- 每条摘录注明文件路径和行号
- 做完的标准：两个文件存在，且后续任务引用的每个 API 都能在里面找到出处

---

## 阶段 1 · 纯语音管道（预计第 1–2 周）

### T1.1 管道跑通
- `voice_agent/bot.py`：SmallWebRTCTransport → Silero VAD → STT → 上下文聚合 → 快模型（OpenAI 兼容接口，非 thinking）→ TTS → 回传
- 系统提示放 `voice_agent/prompts/fast_model.md`，写死五条规则（口语短句一次一问；教材内容只能来自工具；调工具同时说过渡语；工具结果用一两句转述；换问题调取消工具）。本阶段还没有工具，先把规则写上
- 做完的标准：本机起 bot，用 Pipecat 自带的示例客户端能完成一次语音问答

### T1.2 客户端页面
- `web/`：用 Pipecat 的 JS 或 React 客户端 SDK 做最小页面：连接、麦克风、字幕、断开
- 做完的标准：浏览器打开能说话、能听到回答

### T1.3 延迟指标
- 打开 Pipecat 指标，每轮记录 VAD 判停、STT 终稿、快模型首 token、TTS 首包、首音频的时间戳到 `logs/latency.jsonl`
- `scripts/latency_report.py` 算 P50 / P95
- 做完的标准：跑 5 轮后报告能输出 5 个环节的 P50 / P95

### T1.4 文本模式回归
- 不走麦克风：以注入转写文本的方式驱动管道，`scripts/smoke_10turns.py` 跑一段固定的 10 轮脚本对话（`tests/e2e/script_10turns.yaml`）
- 做成 `live` 测试：`tests/e2e/test_scripted_10turns.py`
- 做完的标准：10 轮跑完不崩，报告里有延迟数字

**Gate 1**：首音频 P50 ≤ 1.2 s，P95 ≤ 2 s；打断后停止播放 ≤ 300 ms；10 轮不崩。
**[需要我]** 我戴耳机试听，确认音色、延迟、打断手感。没我的确认不进阶段 2。

---

## 阶段 2 · 同步接入 DeepTutor（预计第 3 周）

### T2.1 DeepTutor 容器
- `docker compose`：deeptutor 服务、数据卷、只发布 3782 到 127.0.0.1，8001 只在内网
- `deeptutor/settings/` 放模板，启动脚本按 `.env` 生成 `model_catalog.json` 等文件：LLM 用非 thinking 快模型；`sandbox_allow_subprocess=false`；auth 关
- 做完的标准：`docker compose up deeptutor` 后网页可用，Settings 显示 LLM 已连通

### T2.2 语音 Partner 与知识库
- 建 Partner `voice-tutor`：`deeptutor/partners/voice-tutor/SOUL.md` 先按 `docs/soul-template.md` 起草（可朗读约束：每句 ≤ 20 字、一次一问、禁 Markdown/LaTeX/代码块/引用编号、公式口语读法、先结论后一句理由；教学风格：追问而不是直接给答案）
  **[需要我]** SOUL.md 我审过才算定稿
- 工具只开 `rag`、`read_memory`、`write_memory`、`write_note`；关 `ask_user`、`web_search`、`exec`
- `scripts/build_kb.py`：把 `data/kb/*.pdf` 建成一个 LlamaIndex 引擎的知识库，解析引擎 PyMuPDF4LLM　**[需要我]** 教材 PDF
- 做完的标准：网页里用 Partner 问一个教材问题能答出来并带引用

### T2.3 DeepTutor 客户端 + 假服务器
- `adapter/deeptutor_client.py`：按 `docs/api-notes/deeptutor.md` 实现 SSE/NDJSON 客户端；学生 id → session_id 的映射持久化到 `data/sessions.json`
- `scripts/record_deeptutor_stream.py`：对真实 DeepTutor 跑 3 个问题，把事件流录成 `tests/fake_deeptutor/fixtures/*.ndjson`（脱敏）
- `tests/fake_deeptutor/server.py`：按 fixture 回放的假服务器，支持延迟注入和中途断开
- 做完的标准：客户端对假服务器的单元测试通过；对真实服务的 `live` 测试通过

### T2.4 契约与同步工具
- `adapter/contracts.py`：`consult_tutor(question, topic) -> {speak, show}`、`quiz_me(topic, n) -> {speak, show}`，`speak ≤ 120 字`
- 先做**阻塞**版本：`adapter/tools/consult_tutor.py`、`quiz_me.py`，挂到快模型
- 做完的标准：语音问教材问题，能得到基于教材的回答（慢没关系，这一阶段只验内容）

### T2.5 可朗读清洗
- `adapter/speakable.py`：去 `#`、`*`、三反引号、`$…$`、`[1]` 式引用；列表改"第一、第二"；数字与单位规范
- `tests/fixtures/speakable/` 放 50 条 Markdown 输入和期望输出
- 做完的标准：50 条全过；清洗后文本里 0 个 Markdown 或公式符号

**Gate 2**：50 条可朗读 100%；关掉重开，第二次会话 `deeptutor memory show` 能看到上一次的内容；session 连续（同一学生两次会话 session_id 相同）。

---

## 阶段 3 · 异步化（预计第 4 周）

### T3.1 异步工具
- 两个工具改为 `cancel_on_interruption=False` 的异步调用；开 `enable_async_tool_cancellation`
- 工具开始 3 s 仍无 `done` 则推一次中间更新（内容取自 `tool_result` 事件），之后每 8 s 最多一次
- 做完的标准：工具在跑时，文本模式下能继续发下一轮并得到快模型回复

### T3.2 空闲投递与去重
- `adapter/idle_queue.py`：中间更新和迟到结果先入队，只在"学生没在说话且 bot 没在播"时出队；同一工具只留最新一条
- 问题哈希去重：同一问题在跑时不再发起第二次
- 30 s 无 `done`：返回超时话术，SSE 不断开，结果到了按空闲规则播
- 做完的标准：`tests/test_idle_queue.py` 覆盖四种时序（bot 在播、学生在说、都空闲、超时）

### T3.3 取消
- 换问题 → 快模型调取消工具 → 关 SSE → 调用 DeepTutor 的中止（按 api-notes；若不支持中止，则丢弃结果并给该 turn 打作废标记，写进 PROGRESS）
- 插话只停 TTS，不取消工具
- 做完的标准：`tests/test_cancel.py` 覆盖"换问题"和"只插话"两条路径

**Gate 3**：工具运行中可继续对话；取消 1 s 内生效；10 轮回归仍通过。
**[需要我]** 我亲自试一次插话和换问题。

---

## 阶段 4 · 屏幕联动与预取（预计第 5–6 周）

### T4.1 屏幕通道
- 工具的 `show` 字段通过 Pipecat 的服务端→客户端消息推到页面；`web/` 加面板：KaTeX 公式、题卡（可点选）、SVG/HTML 图
- 学生在面板上点选的答案作为文本消息回传管道
- 做完的标准：问一道有公式的题，语音念口语读法，屏幕显示公式

### T4.2 出题与判分
- `quiz_me` 走 `deep_question`，题目进题库；学生作答后判分并写记忆
- 做完的标准：一次完整的"出题 → 作答 → 判分 → 记录"

### T4.3 预取
- `adapter/prefetch.py`：进入 Mastery Path 第 k 步时后台预生成第 k+1 步的讲解和 2–3 题；缓存 key = 学生 id + 步骤 id，有效期 2 h；跳步作废
- 先用进程内字典，再切 Redis（compose 加 redis 服务）
- 做完的标准：命中缓存时 `consult_tutor` 1 s 内返回；`tests/test_prefetch.py` 覆盖命中、过期、跳步

### T4.4 部署
- compose 完整版：voice-agent、deeptutor、coturn、（可选）funasr、redis；Caddy 做 TLS 反代，只暴露 WebRTC/WS 和网页
- `docs/DEPLOY.md`：一台新机器从零到可用的步骤
  **[需要我]** 服务器、域名、是否需要 TURN
- 做完的标准：按 DEPLOY.md 在目标机器上一次起成功

**Gate 4**：预取命中 1 s 内返回；10 名学生试用通过（这一条由我来做）。

---

## PROGRESS.md 的格式

```
| 日期 | 任务 | 分支 | 证据 | 未验证 |
| --- | --- | --- | --- | --- |
| 2026-10-03 | T0.1 | task/T0-1-skeleton | pytest 0 passed, CI 绿 | 无 |
```

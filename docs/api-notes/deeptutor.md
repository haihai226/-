# DeepTutor v1.6.12 API 摘录

日期：2026-10-01
来源：只读 submodule `vendor/DeepTutor/`。下文所有 `path:line` 都相对于 `vendor/DeepTutor/`，行号对应 tag **v1.6.12（commit ef2d9e5c3c99）**。升级 DeepTutor 后必须重新核对。
写法约定：凡是源码里找不到的，写"源码中未找到"并注明搜了什么；凡是没跑过的，标"未验证"。

---

## 0. 先看结论（对 voice-tutor 设计影响最大的几点）

1. **有两套对话入口，能力不同**：
   - **Partner 入口**（`/api/partners/{id}/chat*`、`WS /ws/partners/{id}`）：每一轮都写死 `active_capability="chat"`（`deeptutor/services/partners/runtime.py:809`），请求体**没有** `capability` / `kb` / `tools` 字段（`deeptutor/api/routers/partners.py:298-306`）。KB 是 Partner 作用域里的**全部** KB（`runtime.py:691`、`:810`）。**Partner 入口跑不了 `deep_question` / `mastery_path`。**
   - **统一 turn 入口**（`WS /ws`，protocol 2.0；CLI `deeptutor run` 也走同一个 `TurnApplicationService`）：可以指定 `capability`、`knowledge_bases`、`tools`、`config`（`deeptutor/core/turn_request.py:123-136`）。但它**不走 Partner**，不加载 SOUL.md。
   - 所以 `consult_tutor` 可以走 Partner，`quiz_me`（deep_question）只能走 `/ws` 或 CLI。
2. **Partner 的 HTTP SSE 不是逐字流式**：`execute-stream` 只发 `session` → 若干 `thinking` → **一次性**完整 `content` → `done`（或 `error`）（`partners.py:1729-1745`）。没有 `tool_call` / `tool_result` / 增量 `content`。要逐字流必须用 `WS /ws/partners/{id}`，它把每个 StreamEvent 包成 `{"type":"stream_event","event":{...}}` 转发（`deeptutor/services/partners/manager.py:1285-1286`）。
3. **中止**：Partner WS 发 `{"action":"stop","session_key":...}`（`partners.py:1877-1879`）；统一 `/ws` 发 `cancel_turn`（`deeptutor/api/routers/unified_ws.py:288-303`）。都是对 asyncio task 做 `cancel()`。Partner 的 HTTP/SSE turn 没有登记在 `live_turns` 里，`stop` 停不了它，只能断开 SSE 连接（生成器 `finally` 里 `task.cancel()`，`partners.py:1746-1748`，断开时是否一定触发：未验证）。
4. **session id**：Partner 接受客户端自定 id（任何符合 `^[^<>"/\\|?*\x00-\x1f\x7f]{1,128}$` 的 key，`deeptutor/services/partners/web_continuity.py:22`）。统一 `/ws` **不接受**客户端新造的 id：传了一个不存在的 `session_id` 会直接报 `"Conversation not found in this workspace."`（`deeptutor/services/session/turns/request_preparer.py:170-174`），只能先不传 id，从 `session` 事件里拿服务端生成的 `unified_<毫秒>_<8位hex>`（`deeptutor/services/session/sqlite_store.py:1101`）。
5. **单用户模式（auth 关闭）下所有学生共用一份 Partner 记忆**：auth 关闭时调用方是本地 admin，`personal_actor_id()` 对 admin 返回 `None`（`deeptutor/services/partners/interaction.py:63-67`），于是走"legacy"作用域：会话目录是 `data/partners/<id>/sessions`，自有记忆是 Partner 作用域那一份（`interaction.py:140-149`）。按学生区分 session 只能隔离对话历史，**记忆不按学生隔离**。
6. **Partner 回合里没有 `read_memory` / `write_memory`**：它们被强制移除，换成 `partner_read` / `partner_memorize` / `partner_search`（`deeptutor/agents/loop/pipeline.py:96`、`:775-776`；`deeptutor/tools/partner_memory.py:25-29`）。
7. **auth 能关，而且默认就是关的**：`auth.json` 的 `"enabled": False` 是默认值（`deeptutor/services/config/runtime_settings.py:80-82`）。
8. 浏览器**不需要**直连 8001：Next.js 中间件把 `/api/*`、`/ws/*` 转发到后端（`web/proxy.ts:17-26`、`:64-73`）。

---

## 1. Partner HTTP / SSE / WebSocket API

### 1.1 路由挂载

| 前缀 | 来源 | 鉴权依赖 |
|---|---|---|
| `/api/partners` | `deeptutor/api/main.py:754` | `_auth = [Depends(require_learning_surface)]`（`main.py:591`） |
| `/ws/partners` | `deeptutor/api/main.py:761` | 在 handler 内部调用 `ws_require_auth`（`partners.py:1783-1785`） |
| `/ws`（统一 turn 协议） | `unified_ws.py:43` 的 `@router.websocket("/ws")`，挂载于 `main.py:784` | 同上，handler 内部 `ws_require_auth`（`unified_ws.py:49-51`） |

Partner 路由（`deeptutor/api/routers/partners.py`，只列和 voice-tutor 相关的）：

| 方法 路径 | 行号 | 作用 |
|---|---|---|
| `GET /api/partners` | 641 | 列表 |
| `POST /api/partners` | 744 | 创建（body 见 §6.4） |
| `GET /api/partners/{id}` | 951 | 详情 |
| `PATCH /api/partners/{id}` | 1027 | 改配置（`UpdatePartnerRequest`，`partners.py:263-276`） |
| `POST /api/partners/{id}/start` / `stop` | 1067 / 1087 | 启停 runtime |
| `GET/PUT /api/partners/{id}/soul` | 1245 / 1250 | 读写 SOUL.md，body `{"content": str}`（`partners.py:279-280`） |
| `GET/POST /api/partners/{id}/assets` | 1277 / 1282 | 给 Partner 拷入 KB / skill / notebook（body `{"knowledge_bases":[], "skills":[], "notebooks":[]}`，`partners.py:225-228`） |
| `GET /api/partners/{id}/history?session_key=&session_id=&limit=` | 1352 | 历史 |
| `GET /api/partners/{id}/sessions` 等 | 1412-1497 | 会话 list/archive/resume/delete/branch |
| `POST /api/partners/{id}/chat` | 1633 | 一次性 HTTP，返回 JSON |
| `POST /api/partners/{id}/chat/execute-stream` | 1751 | SSE |
| `WS /ws/partners/{id}` | 1764 | Web 聊天 socket（前端用的就是它） |

### 1.2 鉴权

- HTTP：`require_auth` 从 `Authorization: Bearer <token>` 或 cookie `dt_token` 取 token（`deeptutor/api/routers/auth.py:99`、`:367-396`、`:419-428`）；`AUTH_ENABLED` 为假时直接放行并装入本地 admin（`auth.py:446-447`、`:661-662`）。
- WebSocket：`ws_require_auth` 在 auth 打开时读 query `?token=` 或 cookie `dt_token`，失败 `close(4001)`（`auth.py:557-563`）。auth 关闭时不校验。
- 登录：`POST /api/auth/login`（`auth.py:767`）；auth 关闭时返回 `{"ok": true, "message": "Auth is disabled — no login required."}`（`auth.py:770-771`）。
- `AUTH_ENABLED` 在 import 时读一次（`deeptutor/services/auth.py:39-43`），**改了要重启进程**。
- 关闭方法：`data/user/settings/auth.json` 里 `"enabled": false`（默认值，`runtime_settings.py:80-82`）。进程环境变量 `AUTH_ENABLED` / `NEXT_PUBLIC_AUTH_ENABLED` 可以覆盖（`runtime_settings.py:878-883`），但 Docker entrypoint 每次启动会 unset 这些变量并从 JSON 重新导出（`docs-for-user/CONTAINERIZATION.md:405-412`），所以 Docker 里只改 JSON。
- 单用户也是 admin：`require_admin` 在 auth 关闭时把所有请求当 admin（`auth.py:580`、`:586`）。

### 1.3 请求体 `ChatMessageRequest`（`partners.py:298-306`）

```
content: str = ""
session_id: str | None
session_key: str | None
chat_id: str | None
attachments: list[{type, url, base64, filename, mime_type}]   # partners.py:290-295
llm_selection (alias "llmSelection"): dict[str,str] | None
```

- **源码中未找到** `message` / `capability` / `kb` / `tools` 字段（搜了 `ChatMessageRequest` 定义和 `_partner_chat_stream`）。消息字段叫 `content`。
- `llm_selection` 虽然在模型里，但 `partner_chat_http` / `_partner_chat_stream` 都没有把它传给 `mgr.send_message`（`partners.py:1655-1665`、`:1714-1722`），实际用的是 Partner 配置里的 `llm_selection`（`runtime.py:383`）。
- 内容和附件都为空会返回 400（`partners.py:1636-1637`）。

session 解析（`partners.py:1545-1553` + `manager.py:1018-1028`）：
- 传了 `session_key` → 原样用作 key。
- 否则传了 `session_id` → key = `web:<session_id>`。
- 否则传了非 `"web"` 的 `chat_id` → key = `web:<chat_id>`。
- HTTP 两者都没传 → 生成 `uuid4().hex` 作 session_id；WS 两者都没传 → key = `partner:<partner_id>`（所有人共用，别这样用）。

### 1.4 `POST /api/partners/{id}/chat` 响应

`{"partner_id", "session_id", "content"}`（`partners.py:1675-1679`）。错误码：409 = 同一 session 正在回复（`PartnerTurnBusyError`）或 stale session；400 = runtime 错误（`partners.py:1665-1673`）。Partner 没启动时会按需自动启动（`partners.py:1641`）。

### 1.5 `POST /api/partners/{id}/chat/execute-stream`（SSE）

`media_type="text/event-stream"`，头 `Cache-Control: no-cache`、`X-Accel-Buffering: no`（`partners.py:1758-1762`）。帧格式 `event: <name>\ndata: <json>\n\n`（`partners.py:1541-1542`）。

**实际会发出的事件只有这五种**（`partners.py:1681-1748`）：

| event | data | 行号 |
|---|---|---|
| `session` | `{"partner_id", "session_id"}` | 1729 |
| `thinking` | `{"content"}`，只转发 `StreamEventType.THINKING` | 1701-1703 |
| `content` | `{"content"}` 是**完整的最终回复**，只发一次 | 1744 |
| `done` | `{"partner_id", "session_id"}` | 1745 |
| `error` | `{"detail"}` | 1691、1742 |

- `tool_call` / `tool_result`：**这个 SSE 端点不会发**。`on_event` 只处理 THINKING（`partners.py:1701-1703`）。
- 事件之间用 0.15 s 的 `wait_for` 轮询队列（`partners.py:1733`）。

### 1.6 `WS /ws/partners/{partner_id}`（逐字流式用这个）

连接流程：`ws_require_auth` → Partner 不存在或无权限时 `close(4404)`（`partners.py:1795-1799`）→ `accept` → 按需启动 runtime → 发 `{"type":"ready"}`（`partners.py:1819`）。

客户端 → 服务端（`partners.py:1868-1963`）：
- 发消息：`{"content": str, "session_key"?: str, "session_id"?: str, "chat_id"?: str, "attachments"?: [...]}`
- 中止：`{"action":"stop","session_key": ...}`（`partners.py:1877-1879`）
- 重连续看：`{"action":"attach","session_key":...,"include_activity"?: bool}`（`partners.py:1880-1900`）

服务端 → 客户端帧：

| type | 内容 | 来源 |
|---|---|---|
| `ready` | — | partners.py:1819 |
| `accepted` | `session_key` | partners.py:1963 |
| `stream_event` | `event` = `StreamEvent.to_dict()`（见 §1.7） | manager.py:1285-1286 |
| `content` | `content` = 最终全文 | manager.py:1295 |
| `done` | — | manager.py:1295、1299、1304 |
| `stopped` | 被 stop 取消 | manager.py:1297 |
| `error` | `content` | manager.py:1299、1304；partners.py 多处 |
| `turn_busy` | 同一 key 已有进行中的 turn | partners.py:1949 |
| `stale_session` | `content`, `active_session_key` | partners.py:1939-1945 |
| `resuming` / `user_echo` / `attach_busy` / `attach_idle` | attach 流程 | partners.py:1888-1899 |
| `proactive` 及跨渠道 activity 帧 | activity feed | partners.py:1773-1777（docstring）、1967-1987 |

turn 跑在 Partner 实例上，不绑定 socket；socket 断开只是退订，**turn 继续跑**（`partners.py:2008-2012`）。

### 1.7 StreamEvent：全部事件类型与字段

`deeptutor/core/stream.py:17-34` 定义的 `StreamEventType`（统一 `/ws` 的线协议在 `deeptutor/api/contracts/turn_protocol.py:47-62` 里有同样一份）：

`stage_start`, `stage_end`, `thinking`, `observation`, `content`, `tool_call`, `tool_result`, `progress`, `sources`, `result`, `error`, `session`, `session_meta`, `done`, `wait_for_input`

`to_dict()` 字段（`stream.py:61-72`）：`type, source, stage, content, metadata, session_id, turn_id, seq, timestamp`。

`StreamBus` 辅助函数决定了各类型的载荷（`deeptutor/runtime/stream_bus.py`）：

| type | `content` | `metadata` 里一定有的 | 行号 |
|---|---|---|---|
| `content` | 文本增量 | 调用方传入的 trace 元数据 | 156-171 |
| `thinking` | 思考文本 | — | 173-188 |
| `tool_call` | **工具名** | `args`（已去掉 `_` 开头和敏感参数，`deeptutor/runtime/agentic/tool_dispatch.py:197-209`）+ `trace_kind:"tool_call"` | 207-223 |
| `tool_result` | **结果文本** | `tool` = 工具名，`trace_kind:"tool_result"`，可选 `tool_metadata` | 225-241；tool_dispatch.py:862-876 |
| `progress` | 消息 | `current`, `total` | 243-263 |
| `sources` | — | `sources: list` | 265-279 |
| `result` | — | 最终载荷（chat 的回复在 `metadata.response`，`runtime.py:598-599`），附 `cost_summary` / `usage_summary`（`deeptutor/agents/_shared/capability_result.py:35-48`） | 281-293 |
| `error` | 错误文本 | 终止错误带 `turn_terminal: True`、`status`、`error_code`、`retryable`（`deeptutor/services/session/turns/executor.py:1226-1238`） | 295-310 |
| `wait_for_input` | 提示语 | — | 312-332 |

trace 元数据（`deeptutor/core/trace.py:25-51`）：`call_id, phase, label, call_kind`，可选 `trace_id, trace_role, trace_group, trace_kind`。**只有 `call_kind` 为 `llm_final_response` 或 `agent_loop_round` 的 `content` 才算给用户看的回答**（`trace.py:17`）；其它 `content` 是收起的 trace。TTS 只该念这两类。

`done` 的 metadata：`status`（`completed`/`failed`/`cancelled`），可能有 `error_code`、`retryable`、`user_message_id`、`assistant_message_id`、`usage_summary`、`capability_route`（`executor.py:994-1004`、`:1133-1160`；`deeptutor/services/session/turns/lifecycle.py:660-661`）。

`session` 事件（统一 turn 的第一帧）：`source:"turn_runtime"`，`metadata={"session_id", "turn_id", ...}`（`request_preparer.py:765-786`）。

### 1.8 统一 WebSocket `/ws`（protocol 2.0）

每条命令都必须带 `"protocol_version": "2.0"`，否则返回 `unsupported_protocol_version`（`unified_ws.py:194-199`；`turn_protocol.py:12`）。命令（`turn_protocol.py:69-174`）：

| type | 字段 |
|---|---|
| `start_turn`（或 `message`） | 即 `TurnRequest`（§5.1）+ `type` + `protocol_version` |
| `subscribe_turn` | `turn_id`, `after_seq` |
| `resume_from` | `turn_id`, `seq` |
| `subscribe_session` | `session_id`, `after_seq` |
| `unsubscribe` | `turn_id` 或 `session_id` |
| `cancel_turn` | `turn_id`, `command_id`（必填） |
| `submit_user_reply` | `turn_id`, `text` 或 `answers`, `command_id` |
| `user_input` | `turn_id`, `content`, `command_id` |
| `regenerate` | `session_id`, `overrides` |
| `check_active_turn` | `session_id` |
| `ping` | — |

服务端帧：StreamEvent（+`protocol_version`）、`active_turn_info`、`pong`、`command_ack{command_id, command_type, accepted, turn_id, error_code, message}`、`protocol_error{error_code, message, retryable, session_id, turn_id}`（`turn_protocol.py:177-224`）。`start_turn` 之后服务端会自动订阅该 turn（`unified_ws.py:237`）。

---

## 2. CLI：`deeptutor run <capability> <message> --format json`

定义：`deeptutor_cli/main.py:81-125`。CLI 在**本进程内**用 `DeepTutorApp`（`deeptutor/app/facade.py:59`）跑 turn，**不经过 HTTP 服务**。Docker 里用法是 `docker compose exec deeptutor deeptutor run ...`（未验证）。

参数（`main.py:82-105`）：

| 参数 | 说明 |
|---|---|
| `capability`（位置参数） | `chat, deep_solve, deep_question, deep_research, visualize, math_animator, mastery_path`…；别名在 manifest 的 `cli_aliases`，例如 `quiz` → `deep_question`、`mastery` → `mastery_path`（`deeptutor/runtime/bootstrap/builtin_capabilities.py:106`、`:186`；解析见 `facade.py:80-90`） |
| `message`（位置参数） | 用户消息 |
| `--session` | 已有 session id（不存在就报错，见 §3） |
| `--workspace` | 已注册的 workspace id |
| `--tool/-t` | 可重复 |
| `--kb` | 可重复 |
| `--notebook-ref`, `--history-ref` | 可重复 |
| `--language/-l` | 默认 `en` |
| `--config key=value` | 可重复 |
| `--config-json` | JSON 对象 |
| `--format/-f` | `rich` 或 `json` |

**源码中未找到** Partner 的 CLI 聊天命令（`deeptutor_cli/partner.py` 只有 `list/start/stop/create`，`partner.py:17-103`）。CLI 跑不到 SOUL。

`--format json` 的输出（`deeptutor_cli/common.py:185-202`）：**每行一个 JSON**，就是 `app.stream_turn()` 产出的事件 dict（即 §1.7 的 `StreamEvent.to_dict()`，字段 `type, source, stage, content, metadata, session_id, turn_id, seq, timestamp`）。没有 `protocol_version` 字段（只有 WS 适配器会加，`unified_ws.py:70`）。典型顺序：

1. `{"type":"session","source":"turn_runtime","metadata":{"session_id":"unified_…","turn_id":"…"},…}`
2. `stage_start` / `progress` / `thinking` / `tool_call` / `tool_result` / `sources` / `content`（增量）…
3. `{"type":"result","source":"chat","metadata":{"response":"…","cost_summary"?,"usage_summary"?},…}`
4. `{"type":"done","metadata":{"status":"completed","user_message_id":…,"assistant_message_id":…},…}`
5. 可能还有 DONE 之后的 `session_meta`（标题生成，`executor.py:1176-1195`）

遇到 `ask_user` 暂停时，json 模式会自动回一个空回复（`common.py:186-202`）。rich 模式下 Ctrl-C 会调用 `app.cancel_turn()`（`common.py:252-261`）。

注意：`--tool rag` **没有用**。`--tool` 只和"用户可切换"白名单取交集（`deeptutor/agents/_shared/tool_composition.py:81-95`、`:252-256`；白名单 `USER_TOGGLEABLE_TOOL_NAMES` 在 `deeptutor/tools/builtin/__init__.py:1907-1916`，不含 `rag`）。`rag` 在挂了 KB 时自动挂载（`tool_composition.py:47-49`、`deeptutor/agents/loop/pipeline.py:738`）。SKILL.md:62 说可以用 `--tool` 强制打开 context-gated 工具，这和代码不一致，以代码为准；AGENTS.md:62-63 的说法和代码一致。

---

## 3. Sessions

### 3.1 统一 turn（`/ws`、CLI）

- 创建：`start_turn` 不带 `session_id` → `store.ensure_session(None)` → `create_session()`，id = `f"unified_{int(now*1000)}_{uuid4().hex[:8]}"`（`request_preparer.py:174`；`sqlite_store.py:1095-1101`、`:1223-1231`）。
- 复用：带一个已存在的 `session_id`。
- **客户端自定 id：不接受。** id 不存在直接 `RuntimeError("Conversation not found in this workspace.")`（`request_preparer.py:170-173`），WS 上表现为 `protocol_error`，`error_code="start_turn_rejected"`（`unified_ws.py:229-236`）。`create_session(title, session_id)` 内部支持指定 id（`sqlite_store.py:1130-1135`），但 HTTP / WS 都没暴露。**源码中未找到** `POST /api/sessions` 创建接口（`deeptutor/api/routers/sessions.py` 里只有 GET/PATCH/DELETE/POST restore 等，`sessions.py:112-564`）。
- 读：`GET /api/sessions`、`GET /api/sessions/{id}`（`sessions.py:112`、`:287`）；CLI `deeptutor session list|show|open|delete|rename`（`deeptutor_cli/session_cmd.py:16-48`）。
- 拿 id：从第一帧 `session` 事件的 `metadata.session_id` 取，或者每个事件顶层的 `session_id` 字段。
- 对 voice-tutor 的含义：要做"学生 → 固定 session"，得在第一次调用后把服务端返回的 id 存到我们这边。

### 3.2 Partner

- session 是**懒创建**的 JSONL 文件：`<sessions_dir>/<safe_filename(key)>.jsonl`（`deeptutor/services/partners/sessions.py:58-59`）。不需要预先创建。
- 客户端自定 key **接受**，规则 `^[^<>"/\\|?*\x00-\x1f\x7f]{1,128}$`（`web_continuity.py:22`、`:55-66`）。前端自己生成的 key 形如 `web-<8位base36>`（`web/lib/partner-session.ts:62-64`）。
- HTTP 的 `session_id=stu42` → key `web:stu42`（`manager.py:1023-1024`）；直接传 `session_key` 就原样使用。建议统一传 `session_key`，避免 HTTP 和 WS 的 key 推导不一致。
- 只有 turn **正常结束**后才写入用户消息和助手消息（`runtime.py:333-371`）。
- 同一个 key 同一时间只能有一个 turn：WS 返回 `turn_busy`，HTTP 返回 409（`manager.py:1207-1209`；`partners.py:1665-1673`）。
- 存储目录：auth 关闭（admin）→ `data/partners/<id>/sessions/`；已登录的非 admin 用户 → 按用户的目录（`interaction.py:76-86`；`deeptutor/partners/config/paths.py:48-49`）。

---

## 4. 中止正在跑的回合

### 4.1 前端 Stop 按钮的实现

- 主聊天：`ChatStateAdapter.tsx:3083` → `runner.client.send({ type: "cancel_turn", turn_id })`（`web/features/chat/ChatStateAdapter.tsx:3083`），`cancel_turn` 需要 ack（`web/features/chat/transport/TurnRuntimeClient.ts:58-62`）。
- Partner 聊天：`sendStop` → `{"action":"stop","session_key": sessionKey}`（`web/components/partners/PartnerChat.tsx:935-939`），Esc 键也会触发它。

### 4.2 Partner 怎么取消

1. 通过 `WS /ws/partners/{id}` 发 `{"action":"stop","session_key":"<同一个key>"}`。任何连接到同一个 worker 的 socket 都可以发，不要求是发起 turn 的那条（`partners.py:1877-1879` → `manager.py:1267-1275`：`turn.task.cancel()`）。没有确认帧；订阅者会收到 `{"type":"stopped"}`（`manager.py:1296-1298`）。
2. HTTP/SSE 发起的 turn **不在** `live_turns` 里，`stop` 对它无效。只能断开 SSE 连接（`partners.py:1746-1748`；断开时一定触发：未验证）。普通 `POST /chat` **源码中未找到**取消手段（搜了 `stop_web_turn`、`cancel` 在 partners.py 中的调用）。
3. 结论：需要中止就用 WS 起 turn、WS 发 stop。

取消后会发生什么（Partner）：
- `CancelledError` 是 BaseException，不会被 `_execute_turn` 的 `except Exception`（`runtime.py:603`）接住，会一直冒泡，`process_message` 里 `store.append` 那段不会执行（`runtime.py:333-371`）。**这一轮的用户消息和回复都不会写进会话历史。**
- 但**已经执行过的工具副作用不会回滚**：`partner_memorize` 在工具执行时就写 L1 trace 和偏好（`deeptutor/tools/partner_memory.py:191-206`）；`rag` 查询会写一条 L1 `kb/query` trace（`deeptutor/services/rag/service.py:166-185`）。cancel 只能挡住"还没开始"的工具调用；**正在执行**的 `write_preference` 被打断时，是否会留下写了一半的状态：未验证。

### 4.3 统一 `/ws` 怎么取消

`{"type":"cancel_turn","turn_id":"…","command_id":"<唯一id>","protocol_version":"2.0"}` → `command_ack{accepted}`（`unified_ws.py:288-303`）。路径：`TurnApplicationService.cancel_turn` 往协调器提交 `cancel` 命令（`deeptutor/app/service.py:261-283`）→ owner worker 的协调循环读到后 `execution.task.cancel()`（`lifecycle.py:245-248`）。没有 owner 的 turn 直接回收（`service.py:270-277`）。

取消后（`executor.py:1210-1300`）：
- 若还没发过 DONE，先发 `error`（`turn_terminal: True, status: "cancelled"`），再发 `done{status:"cancelled"}`。
- **会把已经流出来的部分回答作为 assistant 消息保存下来**（`executor.py:1243-1275`），turn 状态改成 `cancelled`。
- 标题生成只在 `completed` 时运行（`executor.py:1179`）。
- 记忆：L1 trace 的写入点只有三处——`write_memory` 工具（`deeptutor/tools/builtin/__init__.py:984-989`）、`partner_memorize`（`partner_memory.py:196-201`）、rag 服务（`rag/service.py:172`）；是用 `grep "TraceEvent.new("` 查到的。**源码中未找到**回合结束后自动做记忆整理的钩子：L2/L3 只在调用 `/api/memory/runs/start` 等接口时更新（`deeptutor/api/routers/memory.py:308`）。所以 cancel 之后不会再触发新的记忆写入，但已经完成的工具调用写下的东西还在。

---

## 5. Capabilities

### 5.1 `TurnRequest`（`/ws` 的 start_turn 和 CLI 都用它，`deeptutor/core/turn_request.py:113-196`）

和我们有关的字段：`content`（必填）、`capability`（默认 `"chat"`）、`session_id`、`tools`、`knowledge_bases: list[str]`、`language`、`config: dict`（capability 专用参数）、`llm_selection{profile_id, model_id}`（`turn_request.py:27-31`）、`mastery_path_id`、`mastery_session_mode`、`workspace_mode`、`capability_once`、`auto_route`、`persona`。`extra="forbid"`，多传字段会被拒（`turn_request.py:121`）。

### 5.2 chat + rag 指定 KB

- `/ws`：`{"type":"start_turn","protocol_version":"2.0","content":"…","capability":"chat","knowledge_bases":["textbook"]}`
- CLI：`deeptutor run chat "…" --kb textbook --format json`
- 挂了 KB，`rag` 就会挂载（`pipeline.py:738`、`tool_composition.py:47`）。rag 工具参数是 `query` 和 `kb_name`，`kb_name` 必须是已挂载的 KB 之一（`deeptutor/tools/builtin/__init__.py:105-125`）。
- chat 没有 config 项（`ChatRequestConfig(EmptyConfig)`，`deeptutor/runtime/request_contracts.py:24-25`）。
- Partner 入口：KB = Partner 作用域里的全部 KB（`runtime.py:879-904`）。要让 voice-tutor 用教材 KB，先 `POST /api/partners/voice-tutor/assets {"knowledge_bases":["textbook"]}` 把 KB 拷进 Partner 作用域（`partners.py:1282-1296`；拷贝机制见 `deeptutor/services/partners/workspace.py:20-24`），或者在创建时就带上 `assets`。注意这是**拷贝**，原 KB 更新后要重新拷（推断，未验证）。

### 5.3 deep_question

- 别名 `quiz`（`builtin_capabilities.py:106`）；阶段 `ideation → generation`（manifest，`builtin_capabilities.py:104`）。
- config schema `DeepQuestionRequestConfig`（`request_contracts.py:51-66`，`extra="forbid"`）：

| 字段 | 类型/默认值 |
|---|---|
| `mode` | `"custom"` \| `"mimic"`，默认 `custom` |
| `topic` | str，空则用 `content`（`deeptutor/agents/question/capability.py:111`） |
| `num_questions` | int 1–50，默认 1 |
| `difficulty` | str（流水线校验 `easy/medium/hard`，`deeptutor/agents/question/pipeline.py:171`） |
| `question_types` | list[str]；合法值 `choice, concept, fill_in_blank, short_answer, written, coding`（`pipeline.py:156-168`）；空表示不限 |
| `per_type_counts` | dict[str,int]，非空时总和必须等于 `num_questions` |
| `paper_path`, `max_questions` | mimic 模式用 |

- KB：只用 `knowledge_bases[0]`（`capability.py:43`）。
- 例：`deeptutor run deep_question "勾股定理" --kb textbook --config num_questions=3 --config-json '{"question_types":["choice"],"difficulty":"easy"}' --format json`（参数拼法根据 `main.py` 和 `common.py:829-854` 推出，未实跑）。
- 结果：`result` 事件里 `metadata` = `{"response", "summary":{"success","source","requested","template_count","completed","failed","templates","results","analysis"}, "mode"}`（`pipeline.py:1356-1376`），每道题还会单独发出（`_emit_quiz_question`，`pipeline.py:601-606`）。
- 另外：`capability_routing_enabled`（默认 `False`，`runtime_settings.py:39`）打开后，chat 可能被自动路由到 deep_question（`request_preparer.py:160-168`、`:267`）。

### 5.4 mastery_path

存在（`builtin_capabilities.py:43`、`:161-188`），别名 `mastery`；config 为空（`request_contracts.py:36-37`）。需要先有一个 topic：`POST /api/mastery-paths/topics`（body `ConfirmTopicRequest`：`name, goal, sources, description, emoji, modules`，`deeptutor/api/routers/mastery_path.py:226-248`、`:526`），返回的 path id 形如 `topic_<hex>`（`mastery_path.py:534`），然后在 turn 里带 `mastery_path_id`，`workspace_mode`（或 capability）为 `"mastery_path"`（`deeptutor/services/session/workspace_preferences.py:13`；`request_preparer.py:372-391`）。另有 `WS /ws/mastery-paths`（`mastery_path.py:771`）。细节等做到 mastery_path 任务时再读，**目前未验证**。

---

## 6. Settings（`data/user/settings/*.json`）

### 6.1 位置

`PathService.get_settings_dir()` = `<workspace_root>/user/settings`（`deeptutor/services/path_service.py:225-226`），admin 的 workspace_root 是 `PROJECT_ROOT/data`（`deeptutor/multi_user/paths.py:36`）。全局设置走 admin 作用域（`runtime_settings.py:1345-1351`）。项目根目录的 `.env` **会被忽略**（`runtime_settings.py:464` docstring；`AGENTS.md:37-39`）。文件名就是 `<name>.json`（`runtime_settings.py:499-502`）。

### 6.2 `model_catalog.json`（OpenAI 兼容接口）

结构（`deeptutor/services/config/model_catalog.py:242-251`、`:455-500`）：

```json
{
  "version": 1,
  "connections": [],
  "services": {
    "llm": {
      "active_profile_id": "p1",
      "active_model_id": "m1",
      "profiles": [{
        "id": "p1", "name": "...",
        "binding": "openai",            // 或 "custom"（direct openai_compat，provider_registry.py:193-199）
        "base_url": "https://.../v1",
        "api_key": "<从 .env 渲染，不提交>",
        "api_version": "", "extra_headers": {},
        "models": [{ "id": "m1", "name": "...", "model": "<模型名>",
                     "reasoning_effort": "none" }]
      }]
    },
    "embedding": {...}, "tts": {...}, "stt": {...}, "task": {...}, "search": {...}
  }
}
```

- service 名单：`llm, task, embedding, search, tts, stt, imagegen, videogen`（`model_catalog.py:150-159`）。
- 最小可用示例在 `tests/fixtures/ci_model_catalog.json:1-27`。
- profile 默认值：`binding="openai"`、`extra_headers={}`、`api_format` / `wire_api` 会自动补齐（`model_catalog.py:467-481`）。
- **关闭思考**：模型条目上设 `"reasoning_effort": "none"`（读取位置 `deeptutor/services/config/provider_runtime.py:874`；也可以在每轮的 `LLMSelection.reasoning_effort` 里覆盖，`provider_runtime.py:879-880`）。`none/minimal/minimum` 被视为关闭（`deeptutor/services/llm/reasoning_params.py:22`）。对 DeepSeek / Volcengine / DashScope / MiniMax，或者 `custom` binding 下模型名能匹配上的 qwen3、deepseek-r1 等，会改发 `extra_body`（`thinking.type=disabled` / `enable_thinking=false` / `reasoning_split`）（`reasoning_params.py:13-31`、`:50-53`、`:210-218`）；其余情况发顶层 `reasoning_effort`。Gemini 3 / 2.5-pro 会被降成 `minimal`（`reasoning_params.py:47-49`、`:120-135`）。不设时，名字匹配 reasoner 模式的模型会默认用 `high`（`reasoning_params.py:174-179`）。
- 设置接口返回时会把密钥遮成 `"***"`（`model_catalog.py:34`、`:61-75`）。
- Partner 用哪个模型：Partner 配置的 `llm_selection`，否则用 catalog 当前激活的模型（`runtime.py:383-384`）。

### 6.3 `system.json` / `auth.json` / 其它

`system.json` 默认值（`runtime_settings.py:15-67`）：`backend_port: 8001`、`frontend_port: 3782`、`backend_workers: 1`、`next_public_api_base_external: ""`、`next_public_api_base: ""`、`cors_origin(s)`、`sandbox_allow_subprocess: True`（第 36 行，控制受限 subprocess 形式的 `exec` 沙箱）、`capability_routing_enabled: False`、附件上限等。

- 前端服务端访问后端的地址 `DEEPTUTOR_API_BASE_URL` 按 `next_public_api_base` → `next_public_api_base_external` → `http://127.0.0.1:<backend_port>` 的顺序取（`runtime_settings.py:736-740`）。
- `auth.json` 默认值（`runtime_settings.py:80-88`）：`enabled: False, username: "admin", password_hash: "", token_expire_hours: 24, cookie_secure: False, private_login_hosts: []`。
- `document_parsing.json`、`llamaindex.json` 见 §9。
- `exec` 工具只在有沙箱后端时挂载（`pipeline.py:752`、`:408`；`deeptutor/services/sandbox/service.py:148-158`）。voice-tutor 不需要 exec，建议在 `sandbox_allow_subprocess` 关掉，同时在 Partner 的 `builtin_tools` 里不放 exec。

### 6.4 Partner 配置与工具

- 磁盘位置：`data/partners/<partner_id>/config.yaml`（**YAML，不是 JSON**）（`manager.py:569-571`、`:606-607`；目录 `deeptutor/partners/config/paths.py:11-18`、`:38-40`）。
- 字段（`manager.py:242-286`、`:611-643`）：`name, description, owner_id, workspace_id, channels, llm_selection, backup_llm_selection, model, language, emoji, color, avatar, soul_origin, enabled_tools, builtin_tools, mcp_tools, auto_start`。
- partner id 由 name 或 `partner_id` slugify 而来（ASCII 小写字母数字，其余字符变 `-`），`voice-tutor` 不会被改写（`manager.py:162-190`；`partners.py:757`）。
- 创建：`POST /api/partners`，body `CreatePartnerRequest`（`partners.py:207-228`）：`partner_id, name, description, soul{source:"custom", content}, llm_selection, language, enabled_tools, builtin_tools, mcp_tools（默认 []）, assets{knowledge_bases, skills, notebooks}, start`。CLI `deeptutor partner create <id> -n -s -m`（`deeptutor_cli/partner.py:76-103`）**不能**设置工具和 assets。
- **`enabled_tools`**：用户可切换工具的白名单。`None` = 全部（再和管理员全局开关取交集），`[]` = 一个都不要（`runtime.py:819-840`）。可选值：`brainstorm, web_search, paper_search, zotero_search, reason, geogebra_analysis, imagegen, videogen`（`tools/builtin/__init__.py:1907-1916`）。`web_search` 在这里。
- **`builtin_tools`**：自动挂载工具的白名单。`None` = 不额外限制，`[]` = 全部禁掉（`runtime.py:842-854`；`tool_composition.py:250-264`）。可选值 `CONFIGURABLE_BUILTIN_TOOL_NAMES`：`rag, kb_files, knowledge_frontier, read_source, read_memory, write_memory, read_skill, list_notebook, write_note, question_bank, web_fetch, github, exec, load_tools, cron, ask_user, mastery_topics, mastery_sessions, mastery_open_session, mastery_new_session`（`tools/builtin/__init__.py:1932-1953`）。
  - 条件挂载：`rag/kb_files/knowledge_frontier` 需要有 KB；`write_note/list_notebook` 需要有 notebook；`read_memory` 需要已有记忆；`exec` 需要沙箱（`tool_composition.py:47-64`）。
  - 常开：`write_memory, web_fetch, github, ask_user, cron`（`tool_composition.py:262`）。
  - **Partner 回合会强制挂上 `partner_read/partner_memorize/partner_search`（绕过白名单），并强制移除 `read_memory/write_memory`**（`pipeline.py:96`、`:770-776`；`tool_composition.py:217-224`）。所以在 Partner 的 `builtin_tools` 里放 `read_memory`、`write_memory` 没有效果；Partner 的"记忆读写"就是 `partner_*` 这三个，而且**关不掉**。
  - `ask_user`：在 Partner 回合里，暂停提问的问题本身就成为本轮回复（`runtime.py:12-14`、`:717-718`）。语音场景下最好把它排除在 `builtin_tools` 之外（建议，未验证）。
- 也可以用 `GET /api/partners/tool-options`（`partners.py:707`）查看可选项。
- `mcp_tools` 默认 `[]`（关闭）（`manager.py:274-286`）。

### 6.5 Docker：DEEPTUTOR_EXTRAS 与端口

- 镜像构建时执行 `pip install -r requirements.txt`（`Dockerfile:96-99`），`requirements.txt` 里包含 `-r requirements/partners.txt`（`requirements.txt:22`）。**所以 Docker 镜像不需要 `DEEPTUTOR_EXTRAS=partners`。** 而且 partners extra 只是各 IM 平台的 SDK（`pyproject.toml:176-201`），Web/HTTP 方式使用 Partner 本来就不依赖它。
- **PyMuPDF4LLM 不在镜像依赖里**：requirements 里只有 `PyMuPDF>=1.26.0`（`requirements/cli.txt:50`），`pymupdf4llm` 是 extra `parse-pymupdf4llm`（`pyproject.toml:220`）。需要在 compose 里设 `DEEPTUTOR_EXTRAS: "parse-pymupdf4llm"`，entrypoint 每次启动会调用 `scripts/install_extras.py` 安装（`Dockerfile:432-470`）。装不上也不报致命错误，只是这个功能不可用（`Dockerfile:441-443`）。另有设置接口 `POST /api/settings/document-parsing/install`（`deeptutor/api/routers/settings.py:1454`）。
- 端口：`EXPOSE 8001 3782`（`Dockerfile:534`）；官方 compose 两个都映射了（`docker-compose.yml:84-86`）。镜像 `ghcr.io/hkuds/deeptutor:latest`（`docker-compose.ghcr.yml:60`）→ 我们要钉到具体 tag。
- **浏览器不需要直连 8001**：`web/proxy.ts:64-73` 把 `/api/*`、`/ws/*` 转发到 `DEEPTUTOR_API_BASE_URL`；文档也写明只需要发布 3782（`docs-for-user/CONTAINERIZATION.md:136-144`）。我们的 adapter 在服务端，建议直连 8001（只绑 127.0.0.1）；经过 Next 转发时 SSE / WS 的缓冲表现：未验证。
- CORS：auth 关闭时允许任意 `https?://.*` 来源（`deeptutor/api/main.py:93-96`）。

---

## 7. SOUL.md

- 位置：`<partner 作用域>/user/workspace/SOUL.md`，即 `data/partners/<id>/workspace/user/workspace/SOUL.md`（`deeptutor/services/partners/workspace.py:5-14`、`:61`、`:88-98`；`path_service.py:88-90`、`:222-223`）。
- 格式：**纯 Markdown，没有 schema**。默认内容是 `# Soul\n\nI am a learning companion. …`（`workspace.py:63-67`）。从 persona 复制时会剥掉 YAML frontmatter（`workspace.py:75-87`），说明 SOUL 本身不用 frontmatter。
- 加载：**每一轮**都会在 `_build_context` 里调用 `read_soul(partner_id).strip()` 读一次（`runtime.py:751`），作为 `UnifiedContext.persona_context`，再以 `PromptBlock("persona_style", …)` 注入 system prompt（`deeptutor/agents/loop/prompt_blocks.py:158-159`）。改了文件**下一轮就生效，不用重启**。
- 同时系统提示里的产品身份 "You are DeepTutor" 会被换成 Partner 的 `name` / `description`（`runtime.py:711-716`）。
- 写入：`PUT /api/partners/{id}/soul {"content": "..."}`（`partners.py:1250-1253`），或创建时用 `soul: {"source":"custom","content":"..."}`（`partners.py:192-197`），或 CLI `partner create -s`。Partner 目录初始化时，如果 SOUL 为空会写入默认内容（`manager.py:538-543`）。
- 统一 `/ws` / CLI 回合**不读** SOUL（那边是 `persona` 字段，`turn_request.py:154`）。

---

## 8. Memory

### 8.1 三层结构（`deeptutor/services/memory/paths.py:3-8`、`:48-60`）

```
<memory_root>/
  trace/<surface>/<YYYY-MM-DD>.jsonl   L1，只追加
  L2/<surface>.md                      L2，按 surface 汇总
  L3/<recent|profile|scope|preferences>.md   L3，跨 surface
```

- surface：`chat, notebook, quiz, kb, book, partner, cowriter`；L3 slot：`recent, profile, scope, preferences`（`paths.py:48-60`）。
- `memory_root = PathService.get_memory_dir() = <workspace_root>/memory`（`paths.py:63-66`；`path_service.py:299-300`）。
  - admin/单用户：`data/memory/`（`multi_user/paths.py:36`）
  - Partner 自有（legacy，auth 关闭时）：`data/partners/<id>/workspace/memory/`（`interaction.py:140-149` + `runtime.py:519`）。workspace.py 的 docstring 写的是 `user/workspace/memory`（`workspace.py:13`），和 `get_memory_dir` 的代码对不上，以代码为准。实际落盘路径：未验证。
  - 已登录的非 admin 用户和 Partner 之间的关系记忆：`data/partners/<id>/users/<uid>/workspace/memory`（`interaction.py:151-163`；`partner_memory.py:5-7`）。
- L1 写入点：见 §4.3。L2/L3 由 LLM consolidator 在调用 `/api/memory/runs/start` 等接口时生成（`memory.py:308`）。**源码中未找到**每轮自动整理。
- 文件里引用格式是 entry id `m_xxx` + 脚注（`tools/builtin/__init__.py:950-953`；`deeptutor/services/memory/__init__.py:1-12`）。

### 8.2 读取学生画像

- CLI：`deeptutor memory show [L3|L2|<slot>|<surface>]`，默认 `L3`（拼接四个 L3 文档）；`deeptutor memory show profile` → `L3/profile.md`（`deeptutor_cli/memory.py:21-61`）。**它读的是当前（admin）作用域 `data/memory`，不是 Partner 的记忆。** `memory clear [all|trace|<surface>] [-f]`（`memory.py:63-99`）。
- HTTP：`GET /api/memory/overview`、`GET /api/memory/doc/{layer}/{key}`（例如 `/api/memory/doc/L3/profile`）、`GET /api/memory/trace/{surface}`（`memory.py:84`、`:140`、`:680`）。同样是请求方作用域。
- Partner 视角：`partner_read` 工具返回"自有 + 共享 L3"的拼接（`partner_memory.py:1-15`、`:34-52`）。要在 Partner 外部读 voice-tutor 的记忆，**源码中未找到**专门接口（搜了 partners.py 里的 `memory`）；只能直接读上面的文件。
- 再强调一次：auth 关闭时，所有学生用的是同一份 Partner 自有记忆（§0 第 5 点）。要按学生隔离，要么开 auth、每个学生一个账号（这样走 `users/<uid>` 分支），要么不把记忆当作学生画像来用。这个问题需要决策。

---

## 9. 从 PDF 建知识库（LlamaIndex + PyMuPDF4LLM）

### 9.1 CLI

`deeptutor kb create <name> --doc a.pdf [--doc b.pdf] | --docs-dir <dir>`（`deeptutor_cli/kb.py:139-183`）；追加用 `deeptutor kb add <name> --doc …`（`kb.py:205-246`）。检索测试：`deeptutor kb search <name> "query" --mode hybrid --format json`（`kb.py:271-276`）。

- **CLI 没有 engine / parser 参数**：固定用 LlamaIndex（`kb.py:167-178`），解析引擎读设置文件。**源码中未找到** `--engine` / `--parser` 选项。
- `initialize_knowledge_base(kb_name, source_files, base_dir, api_key, base_url, rag_provider)`（`deeptutor/knowledge/initializer.py:324-331`）；CLI 没有传 `rag_provider`。

### 9.2 HTTP

`POST /api/knowledge-bases`，multipart form（`deeptutor/api/routers/knowledge.py:3391-3403`）：`name`（必填）、`files[]`、`rag_provider`（默认 `DEFAULT_PROVIDER = "llamaindex"`，`deeptutor/services/rag/factory.py:37`）、`pageindex_mode`、`search_mode`、`rel_paths`、`indexing_llm`、`embedding_model`、`storage_workspace_id`。索引在后台任务里跑，进度通过 `/ws` 下的 KB 路由推送（`main.py:631`）。

### 9.3 选用 PyMuPDF4LLM 解析器

- 设置文件 `data/user/settings/document_parsing.json`，v2 结构 `{"version":2,"engine":"<name>","image_caption":false,"engines":{...}}`（`runtime_settings.py:107-122`、`:244-259`）。
- 引擎名常量：`text_only, mineru, docling, markitdown, pymupdf4llm, liteparse, tika`（`runtime_settings.py:136-153`）。**默认是 `text_only`**（`runtime_settings.py:162`）。
- 设 `"engine": "pymupdf4llm"`；该引擎的参数默认值 `{"write_images": true, "image_format": "png", "image_dpi": 150}`（`runtime_settings.py:210-218`）。
- 接口：`PUT /api/settings/document-parsing`，body `{"engine": "pymupdf4llm", "engines": {...}}`（`settings.py:416-428`、`:1344`）；就绪自检 `POST /api/settings/document-parsing/test`（`settings.py:1378`）。
- 生效路径：LlamaIndex 的 document_loader 调用 `get_parse_service().parse(...)`（`deeptutor/services/rag/pipelines/llamaindex/document_loader.py:190-193`），未指定引擎时用 `active_engine()` = 设置里的 `engine`（`deeptutor/services/parsing/service.py:89-92`）。引擎不支持某种文件格式时会自动换别的引擎（`service.py:126-140`）。
- 依赖：Docker 里需要 `DEEPTUTOR_EXTRAS=parse-pymupdf4llm`（§6.5）。
- LlamaIndex 参数在 `data/user/settings/llamaindex.json`（`runtime_settings.py:286-333`）：`retrieval_profile: "hybrid"`、`top_k: 5`、`chunk_size: 512`、`chunk_overlap: 50`、`vector_index_type: "flat"`、`reranker_model: ""` 等。
- 嵌入模型取自 `model_catalog.json` 的 `services.embedding`（§6.2）；没配置嵌入模型能不能建库：未验证。

---

## 未验证清单

- 以上所有内容都来自阅读源码，**没有启动过 DeepTutor**，也没有发过一次真实请求。
- SSE 客户端断开时是否一定取消 turn（§1.5、§4.2）。
- 经过 3782 的 Next 转发访问 SSE / WS 时有没有缓冲（§6.5）。
- Partner 自有记忆的实际落盘路径（§8.1，代码和 docstring 不一致）。
- deep_question 的 CLI 参数拼法（§5.3）；mastery_path 的完整调用流程（§5.4）。
- 给 Partner 拷贝 KB 之后，原 KB 更新是否会同步（§5.2）。

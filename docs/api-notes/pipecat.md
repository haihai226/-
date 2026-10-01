# Pipecat 1.12.0 API 摘录

日期：2026-10-01

> 本文所有行号指 `uv.lock` 锁定的 **pipecat-ai 1.12.0**，路径相对于 `.venv/lib/python3.12/site-packages/`。
> 每条签名、参数名、默认值都从源码抄录；源码里没有的写"源码中未找到"并注明搜了什么。
> 代码片段只用源码里出现过的 API 拼装，**未实际运行**（除非另行注明）。

---

## 0. 先看这几条（与旧版 Pipecat 的主要差异）

| 主题 | 1.12.0 的实际情况 | 出处 |
|---|---|---|
| `PipelineTask` / `PipelineRunner` | 已改名为 `PipelineWorker` / `WorkerRunner`，旧名保留为已弃用别名（1.3.0 起弃用，2.0.0 删除） | `pipecat/pipeline/worker.py:1670`、`pipecat/pipeline/runner.py:27` |
| `WorkerRunner.run(worker)` | 传 worker 已弃用；应先 `await runner.add_workers(worker)` 再 `await runner.run()` | `pipecat/workers/runner.py:238-286`、`:200` |
| `OpenAILLMContext`、`llm.create_context_aggregator()` | **源码中未找到**（在 `pipecat/` 下 grep `OpenAILLMContext`、`def create_context_aggregator` 均无结果）。只能用 `LLMContext` + `LLMContextAggregatorPair` | `pipecat/processors/aggregators/llm_context.py:83`、`llm_response_universal.py:2491` |
| `TransportParams.vad_analyzer` | **不存在**。`TransportParams` 只有 audio/video 字段；VAD 放在 `LLMUserAggregatorParams.vad_analyzer` 或独立的 `VADProcessor` | `pipecat/transports/base_transport.py:25-93`、`llm_response_universal.py:184`、`pipecat/processors/audio/vad_processor.py:29` |
| `allow_interruptions` / `interruption_strategies` | **源码中未找到**（`grep -rn "allow_interruptions\|interruption_strategies" pipecat` 无结果）。打断由用户回合开始策略的 `enable_interruptions` 控制 | `pipecat/turns/user_start/base_user_turn_start_strategy.py:53-78` |
| `StartInterruptionFrame` | **源码中未找到**；只剩 `InterruptionFrame` | `pipecat/frames/frames.py:1221` |
| `enable_async_tool_cancellation` | 1.8.0 起**已弃用**；改为每个工具单独设 `cancellable_by_llm=True` | `pipecat/services/llm_service.py:317,334-366` |
| 取消工具名 | 不是一个通用工具，而是**每个可取消工具各一个 `cancel_<工具名>`**，例如 `cancel_consult_tutor`、`cancel_quiz_me` | `pipecat/utils/async_tool_cancellation.py:40-53` |
| 系统提示 | 放在 `LLMContext` 首条 `system` 消息的写法 1.9.0 起弃用；应设到 LLM 服务的 `settings.system_instruction` | `pipecat/adapters/base_llm_adapter.py:209-234` |
| 构造参数 `model=`、`params=InputParams(...)`、`voice_id=` | 0.0.105 起弃用，改用 `settings=XxxService.Settings(...)` | `pipecat/services/qwen/llm.py:52-56`、`pipecat/services/minimax/tts.py:206-216` |

---

## 1. Function calling（异步工具）

### 1.1 注册

`LLMService.register_function` — `pipecat/services/llm_service.py:963-1038`

```python
def register_function(
    self,
    function_name: str | None,          # None = 兜底处理器（处理所有函数调用）
    handler: Any,                       # async def handler(params: FunctionCallParams) -> None
    *,
    cancel_on_interruption: bool | None = None,   # None → @tool_options 的值 → 默认 True
    timeout_secs: float | None = None,            # None → @tool_options → 全局 function_call_timeout_secs
    cancellable_by_llm: bool | None = None,       # None → @tool_options → 默认 False
)
```

- 优先级是**显式参数 > `@tool_options` 装饰器 > 默认值**（`llm_service.py:1222-1253`）。
- `cancellable_by_llm=True` 但 `cancel_on_interruption=True` 时会打 warning 并按 False 处理（`llm_service.py:1186-1220`）。
- 注册名与已存在的 `cancel_*` 内置工具同名时抛 `ValueError`（`llm_service.py:1012-1016`）。

`register_direct_function` — `llm_service.py:1068-1123`：**1.4.0 起弃用**（"Use `LLMContext(tools=[...])` instead"），而且它**没有** `cancellable_by_llm` 参数。不要用。

**另一种注册方式（1.12 推荐）**：把 handler 挂在 `FunctionSchema(handler=...)` 上或直接把 direct function 放进 `LLMContext(tools=[...])`，LLM 服务会在每个 `LLMContextFrame` 上自动注册（`llm_service.py:1281-1300, 1425-1482`；`pipecat/adapters/schemas/function_schema.py:32-39`）。此时调用选项用 `@tool_options` 装饰器给。

`tool_options` 装饰器 — `pipecat/adapters/schemas/direct_function.py:290-355`

```python
def tool_options(
    fn=None, *,
    cancel_on_interruption: bool = True,
    timeout_secs: float | None = None,
    cancellable_by_llm: bool = False,
)
```
只是把 `_pipecat_cancel_on_interruption` / `_pipecat_timeout_secs` / `_pipecat_cancellable_by_llm` 挂到函数上（`:348-352`），不注册任何东西。

### 1.2 `FunctionCallParams` — `llm_service.py:116-171`

```python
@dataclass
class FunctionCallParams:
    function_name: str
    tool_call_id: str
    arguments: Mapping[str, Any]
    llm: LLMService[Any]
    pipeline_worker: PipelineWorker
    context: LLMContext
    result_callback: FunctionCallResultCallback
    app_resources: Any = None              # = PipelineWorker(..., app_resources=...)
    worker_runner: WorkerRunner | None = None
    # tool_resources: 1.2.0 起弃用的属性别名
```

`FunctionCallResultCallback` 协议 — `llm_service.py:94-114`：

```python
async def __call__(self, result: Any, *, properties: FunctionCallResultProperties | None = None) -> None
```

### 1.3 `FunctionCallResultProperties` — `pipecat/frames/frames.py:820-840`

```python
@dataclass
class FunctionCallResultProperties:
    run_llm: bool | None = None
    on_context_updated: Callable[[], Awaitable[None]] | None = None
    is_final: bool = True
```

- `is_final=False`：中间更新。**只对异步调用（`cancel_on_interruption=False`）有效**；同步调用传了会 warning 并被丢弃（`llm_service.py:1752-1759`）。
- 中间更新**不会**清除超时计时器，只有 final 才清（`llm_service.py:1773-1780`）。
- 已 settle（已 final、超时或被取消）后再调 `result_callback` 会被拒绝并 warning（`llm_service.py:1764-1771`）。
- `on_context_updated`：结果写入 context 后，助手聚合器在**独立 task** 中调用它（`llm_response_universal.py:2029-2036`）。
- `run_llm` 的判定（助手聚合器 `llm_response_universal.py:2001-2027`）：仅当 `frame.result` 为真值时才考虑；优先 `properties.run_llm`，其次 `frame.run_llm`，否则"同组最后一个完成时才跑"。**注意：中间更新也走这段逻辑，所以不显式传 `run_llm=False` 的中间更新默认会触发一次 LLM 推理**（无同组兄弟调用时）。用户正在说话时不跑；机器人正在说话时推迟到 `BotStoppedSpeaking`（`:2038-2068`）。

### 1.4 是什么让调用变成"异步"（不阻塞对话）

唯一开关是 **`cancel_on_interruption=False`**（`llm_service.py:182-189` 文档、`:1569-1580` `_function_is_async`）。效果：

1. 调用时广播 `FunctionCallInProgressFrame(cancel_on_interruption=False, ...)`（`llm_service.py:1731-1738`）。
2. 助手聚合器往 context 写 assistant `tool_calls` 消息 + 一条 `role="tool"` 的 "started" 占位（`status: "running"`），而同步调用写的是 `"IN_PROGRESS"`（`llm_response_universal.py:1926-1960`；占位构造见 `pipecat/processors/aggregators/async_tool_messages.py:201-223`）。
3. 中间结果以 **`role="developer"`** 消息追加（`async_tool_messages.py:226`；聚合器 `llm_response_universal.py:2070-2085`）。
4. final 结果：如果对话在此期间没有新的 user/developer 消息，就原地覆盖占位（和同步一样）；否则追加一条 developer "final" 消息（`llm_response_universal.py:2087-2108, 2347-2393`）。
5. 打断时 `LLMService._handle_interruptions` 只取消 `cancel_on_interruption=True` 的调用（`llm_service.py:826-829`），异步调用继续跑。
6. 只要注册了异步工具，`ASYNC_TOOL_INSTRUCTIONS` 会自动拼进系统提示（`llm_service.py:658-693`；文本 `async_tool_messages.py:110`）。
7. `run_function_calls` 用 `self.create_task(...)` 在后台跑每个调用（并行模式 `llm_service.py:1689-1695`）——同步/异步都是后台 task，区别在于 context 占位和打断/推理行为。

> **Qwen 注意**：`QwenLLMService.supports_developer_role = False`（`pipecat/services/qwen/llm.py:33`），所以上述 developer 消息在发给 API 前会被改写成 `role="user"`（`pipecat/adapters/services/open_ai_adapter.py:255-266`；调用处 `pipecat/services/openai/base_llm.py:340-344`）。DeepSeek 同样（`pipecat/services/deepseek/llm.py:64`）。

> **源码观察**：异步调用启动后，聚合器**不会**自动再触发一次推理（`_handle_function_call_in_progress` 里没有 push context，`llm_response_universal.py:1926-1960`）。LLM 在同一回复里和 tool_call 一起输出的文字会照常被 TTS 念出；如果模型只回了 tool_call 没有文字，机器人会静默直到用户再说话或有结果到达。需要"马上说一句"时，可在 handler 里推 `TTSSpeakFrame`（该帧的 assistant 消息不会让异步结果变成 deferred，见 `llm_response_universal.py:2354-2360` 的说明），或用带 `run_llm=True` 的中间更新。这一推论**未验证**。

### 1.5 LLM 主动取消（built-in async tool cancellation）

- 开启：`register_function(..., cancel_on_interruption=False, cancellable_by_llm=True)`（或 `@tool_options(...)`）。
- 自动添加的工具名：`cancel_tool_name(name)` = `"cancel_" + name`（`pipecat/utils/async_tool_cancellation.py:40-53`）。schema 由 `build_cancel_tool_schema` 构造，唯一可选参数 `tool_call_id`（`:55-90`）。
- 何时加：每次 `_sync_registered_tool_handlers` 末尾调 `_sync_cancel_tools()`（`llm_service.py:1481`），时机是 `start()`（`:577`）和每个 `LLMContextFrame`（`:786`）。schema 放进 `adapter.builtin_tools`，handler 注册为同步的 `_cancel_tool_handler`（`:1953-1988`）。同时把 `ASYNC_TOOL_CANCELLATION_INSTRUCTIONS` 拼进系统提示（`:685-686`；文本 `async_tool_cancellation.py:21-38`）。
- `cancel_*` 调用不出现在 `on_function_calls_started` / `FunctionCallsStartedFrame` 里（`llm_service.py:1604-1611`）。
- 取消如何到达正在运行的 handler（`_cancel_function_call_tasks`，`llm_service.py:2051-2113`）：
  1. 先把 runner item 标为 settled（之后的 `result_callback` 被拒）；
  2. `await self.cancel_task(task)` → handler 里抛 **`asyncio.CancelledError`**（handler 可 `try/except CancelledError` 做清理后 `raise`；`:1845-1849`）；
  3. 广播 `FunctionCallCancelFrame(function_name, tool_call_id, run_llm=False)`（`:2115-2139`）；
  4. 触发事件 `on_function_calls_cancelled(service, function_calls)`。
  5. `cancel_*` 工具自身以 `run_llm=True` 返回 `{"cancelled": tool_call_id, "function_name": ...}`（`:2045-2049`）。同一工具有多个在跑且没给 `tool_call_id` 时拒绝并列出候选 id（`:2016-2041`）。
- 被取消的异步调用在 context 里以 developer "cancelled" 消息结算（`llm_response_universal.py:2110-2144`；文本 `async_tool_messages.py:280`）。
- 超时（`timeout_secs` / `function_call_timeout_secs`）走同一取消路径，但 `run_llm=True`（`llm_service.py:1794-1812, 2141-2166`）。

### 1.6 相关事件 / 帧

| 名称 | 定义 | 说明 |
|---|---|---|
| 事件 `on_function_calls_started(service, function_calls)` | `llm_service.py:256-277, 1610` | 不含 `cancel_*` |
| 事件 `on_function_calls_cancelled(service, function_calls)` | `llm_service.py:2110-2111` | 打断、超时、LLM 取消都会触发 |
| `FunctionCallsStartedFrame(function_calls)` SystemFrame | `frames.py:1458` | |
| `FunctionCallInProgressFrame(function_name, tool_call_id, arguments, cancel_on_interruption=False, group_id)` ControlFrame，不可打断 | `frames.py:2299-2325` | |
| `FunctionCallResultFrame(function_name, tool_call_id, arguments, result, run_llm=None, properties=None, error=None)` DataFrame，不可打断 | `frames.py:843-871` | 中间更新也是这个帧 |
| `FunctionCallCancelFrame(function_name, tool_call_id, run_llm=False)` SystemFrame | `frames.py:1472-1486` | |
| `FunctionCallFromLLM(function_name, tool_call_id, arguments, context)` | `frames.py:1439-1455` | |
| `LLMSetToolsFrame(tools)` | `frames.py:767-779` | 运行中换工具集 |
| `FunctionCallObserver`（事件 `on_function_call_event`） | `pipecat/observers/function_call_observer.py:98,152` | 可用于记工具耗时 |

不要和 `FunctionCallUserMuteStrategy` 一起用：它在 `FunctionCallsStartedFrame` 到结果/取消之间静音用户（`pipecat/turns/user_mute/function_call_user_mute_strategy.py`），对长时异步工具等于禁止插话。`LLMUserAggregatorParams.user_mute_strategies` 默认为空列表（`llm_response_universal.py:181`）。

### 1.7 Tool schema

`FunctionSchema` — `pipecat/adapters/schemas/function_schema.py:20-39`
```python
FunctionSchema(name: str, description: str, properties: dict[str, Any], required: list[str],
               handler: FunctionCallHandler | None = None)
```
`ToolsSchema` — `pipecat/adapters/schemas/tools_schema.py:41-69`
```python
ToolsSchema(standard_tools: Sequence[FunctionSchema | DirectFunction],
            custom_tools: dict[AdapterType, list[dict[str, Any]]] | None = None)
```
`LLMContext(tools=...)` 也接受普通 list，会被规范化成 `ToolsSchema`（`llm_context.py:91-112`）。

### 1.8 最小示例（按源码拼装，未运行）

```python
import asyncio
from pipecat.adapters.schemas.function_schema import FunctionSchema
from pipecat.adapters.schemas.tools_schema import ToolsSchema
from pipecat.frames.frames import FunctionCallResultProperties
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.services.llm_service import FunctionCallParams

async def consult_tutor(params: FunctionCallParams):
    try:
        # 中间更新：只进 context，不触发推理
        await params.result_callback(
            {"status": "searching"},
            properties=FunctionCallResultProperties(is_final=False, run_llm=False),
        )
        result = ...  # 调 adapter/deeptutor_client（异步）
        await params.result_callback(result)          # final，默认 is_final=True
    except asyncio.CancelledError:
        # 被打断不会走到这里（异步工具不随打断取消）；LLM 调 cancel_consult_tutor 或超时才会
        raise

consult_schema = FunctionSchema(
    name="consult_tutor", description="...",
    properties={"question": {"type": "string"}}, required=["question"],
)
llm.register_function(
    "consult_tutor", consult_tutor,
    cancel_on_interruption=False,   # 异步
    cancellable_by_llm=True,        # 自动广告 cancel_consult_tutor
    timeout_secs=60,
)
context = LLMContext(tools=ToolsSchema(standard_tools=[consult_schema]))
```

---

## 2. SmallWebRTC 传输与开发 runner

### 2.1 `SmallWebRTCTransport` — `pipecat/transports/smallwebrtc/transport.py:951-1055`

```python
SmallWebRTCTransport(
    webrtc_connection: SmallWebRTCConnection,
    params: TransportParams,
    input_name: str | None = None,
    output_name: str | None = None,
)
```
- `.input()` / `.output()` 返回 `SmallWebRTCInputTransport` / `SmallWebRTCOutputTransport`（`:1005-1025`）。
- 可注册事件：`on_app_message(transport, message, sender)`、`on_client_connected(transport, webrtc_connection)`、`on_client_disconnected(transport, webrtc_connection)`（`:1000-1003, 1047-1061`）。类 docstring 里写的 `on_client_message` **未被注册**，以 `_register_event_handler` 为准。
- 收到 data channel 消息时，input 以 `broadcast_frame(InputTransportMessageFrame, message=...)` 推进管道（`:762-769`）。
- 客户端连上时 input 推 `ClientConnectedFrame`（`:1053-1055`）。

### 2.2 `TransportParams` — `pipecat/transports/base_transport.py:25-93`（音频相关字段与默认值）

```
audio_out_enabled: bool = False          audio_in_enabled: bool = False
audio_out_sample_rate: int | None = None audio_in_sample_rate: int | None = None
audio_out_channels: int = 1              audio_in_channels: int = 1
audio_out_bitrate: int = 96000           audio_in_filter: BaseAudioFilter | None = None
audio_out_10ms_chunks: int = 4           audio_in_stream_on_start: bool = True
audio_out_mixer = None                   audio_in_passthrough: bool = True
audio_out_destinations: list[str] = []
audio_out_end_silence_secs: int = 2
audio_out_auto_silence: bool = True
audio_out_write_timeout_secs: float = 10.0
```
**无 VAD 字段**（见 §3）。采样率为 None 时取 `PipelineParams.audio_in_sample_rate=16000` / `audio_out_sample_rate=24000`（`pipecat/pipeline/worker.py:186-187`）。

### 2.3 `SmallWebRTCConnection` — `pipecat/transports/smallwebrtc/connection.py:237-291`

```python
SmallWebRTCConnection(ice_servers: list[str] | list[IceServer] | None = None,
                      connection_timeout_secs: int = 60)
```
`IceServer = RTCIceServer`（aiortc，`:233-234`）。方法：`initialize(sdp, type)` `:411`、`connect()` `:420`、`renegotiate(...)` `:443`、`disconnect()` `:540`、`get_answer()` `:560`、`send_app_message(message)` `:752`（data channel 未开时排队）、`add_ice_candidate(candidate)` `:822`。事件：`app-message`、`track-started`、`track-ended`、`connecting`、`connected`、`disconnected`、`closed`、`failed`、`new`（`:281-290`）。

### 2.4 信令：`SmallWebRTCRequestHandler` — `pipecat/transports/smallwebrtc/request_handler.py`

```python
SmallWebRTCRequest(sdp: str, type: str, pc_id: str | None = None,
                   restart_pc: bool | None = None, request_data: Any | None = None)   # :26-49，from_dict 兼容 requestData
SmallWebRTCPatchRequest(pc_id: str, candidates: list[IceCandidate])                  # :67-76
IceCandidate(candidate: str, sdp_mid: str, sdp_mline_index: int)                     # :52-64
ConnectionMode.SINGLE / MULTIPLE                                                      # :79-83
SmallWebRTCRequestHandler(ice_servers: list[IceServer] | None = None, esp32_mode: bool = False,
                          host: str | None = None, connection_mode: ConnectionMode = ConnectionMode.MULTIPLE)  # :97-121
async handle_web_request(request, webrtc_connection_callback) -> dict[str, str] | None   # :160 返回 SDP answer + pc_id
async handle_patch_request(request: SmallWebRTCPatchRequest)                              # :243
async close()                                                                             # :262
```

自建 FastAPI 时照 runner 的写法（`pipecat/runner/run.py:995-1036`）：

```python
handler = SmallWebRTCRequestHandler(ice_servers=None)

@app.post("/api/offer")
async def offer(request: SmallWebRTCRequest, background_tasks: BackgroundTasks):
    async def cb(connection: SmallWebRTCConnection):
        background_tasks.add_task(run_bot, connection)
    return await handler.handle_web_request(request=request, webrtc_connection_callback=cb)

@app.patch("/api/offer")
async def ice_candidate(request: SmallWebRTCPatchRequest):
    await handler.handle_patch_request(request)
```

### 2.5 开发 runner（`runner` extra）

- extra 内容：`uvicorn`、`fastapi`、`pipecat-ai-prebuilt>=1.2.2`（`pipecat_ai-1.12.0.dist-info/METADATA:171-174`）；WebRTC 需要 `webrtc` extra（aiortc，`METADATA:203-205`）。本项目 `pyproject.toml` 已含 `pipecat-ai[qwen,runner,silero,webrtc]~=1.12.0`。
- 入口约定：模块里定义 **`async def bot(runner_args)`**，然后 `from pipecat.runner.run import main; main()`（`pipecat/runner/run.py:18-40`）。runner 先在 `__main__` 找 `bot`，再 `import bot`，再扫描当前目录 `.py`（`run.py:490-531`）。
- WebRTC 会话的参数类型：`SmallWebRTCRunnerArguments(webrtc_connection: Any)`，继承 `RunnerArguments`（`body`、`session_id`、`call_data`、`cli_args`、`handle_sigint=False`、`handle_sigterm=False`、`pipeline_idle_timeout_secs=300`）（`pipecat/runner/types.py:141-175, 226-233`）。`body` 来自客户端 `request_data`（`run.py:1015-1020`）。
- 便捷工厂：`await create_transport(runner_args, {"webrtc": lambda: TransportParams(...)})`（`pipecat/runner/utils.py:598-663`）。
- 路由：`POST/PATCH /api/offer`（`run.py:1000-1036`）、`POST /start`、`GET /status`；默认 `--host localhost --port 7860`（`run.py:187-188, 1714-1715`）；`-t webrtc` 只开 WebRTC（`:1716-1735`）。
- 预置测试客户端：`pipecat_ai_prebuilt.frontend.PipecatPrebuiltUI` 挂在 **`/client`**，`/` 重定向到 `/client/`（`run.py:942-955`）。已安装 `pipecat_ai_prebuilt 1.2.2`。（旧包 `pipecat_ai_small_webrtc_prebuilt` 未安装、源码不引用。）

```python
from pipecat.runner.types import RunnerArguments
from pipecat.runner.utils import create_transport
from pipecat.transports.base_transport import TransportParams

async def bot(runner_args: RunnerArguments):
    transport = await create_transport(runner_args, {
        "webrtc": lambda: TransportParams(audio_in_enabled=True, audio_out_enabled=True),
    })
    ...  # 组管道并运行（见 §5、§6）

if __name__ == "__main__":
    from pipecat.runner.run import main
    main()
```

---

## 3. Silero VAD

- `SileroVADAnalyzer(*, sample_rate: int | None = None, params: VADParams | None = None)` — `pipecat/audio/vad/silero.py:130-169`；只支持 8000/16000 Hz；模型 `silero_vad.onnx` 随包附带，强制 CPU ONNX。`silero` extra 没有额外依赖（`METADATA:182`），`onnxruntime` 是基础依赖（`METADATA:45`）。
- `VADParams` — `pipecat/audio/vad/vad_analyzer.py:47-60`，默认值来自 `:25-28`：

```
confidence: float = 0.7
start_secs: float = 0.2
stop_secs:  float = 0.2
min_volume: float = 0.6
```

- **接在哪里（1.12）**：不在 `TransportParams`。两种方式：
  1. `LLMUserAggregatorParams(vad_analyzer=SileroVADAnalyzer(...))`（`llm_response_universal.py:184`）——用户聚合器内建 `VADController`，用 `broadcast` 把 `VADUserStartedSpeakingFrame` / `VADUserStoppedSpeakingFrame` / `UserSpeakingFrame` 推向上下游（`:765-778, 1325-1338`），所以位于上游的 STT（如 `SegmentedSTTService`）也能收到。
  2. `VADProcessor(*, vad_analyzer, speech_activity_period=0.2, audio_idle_timeout=1.0)` 放进管道（`pipecat/processors/audio/vad_processor.py:29-99`），同样 broadcast 这些帧。
- `audio_idle_timeout`（默认 1.0 s）：SPEAKING 状态下没有音频帧时强制判停（`llm_response_universal.py:140-142`）。
- 帧上带 `start_secs` / `stop_secs` 和 `timestamp`（`frames.py:1325-1351`）；`UserBotLatencyObserver` 用 `timestamp - stop_secs` 作为"用户真正停止说话"时刻（`pipecat/observers/user_bot_latency_observer.py:650-654`）。

---

## 4. 服务

### 4.1 `OpenAILLMService` / `BaseOpenAILLMService`

`BaseOpenAILLMService.__init__` — `pipecat/services/openai/base_llm.py:162-260`

```python
(*, model: str | None = None, api_key=None, base_url=None, organization=None, project=None,
 default_headers: Mapping[str, str] | None = None, service_tier: str | None = None,
 params: InputParams | None = None,           # 弃用
 settings: Settings | None = None,
 retry_timeout_secs: float | None = 5.0, retry_on_timeout: bool | None = False, **kwargs)
```
`**kwargs` 继续传给 `LLMService.__init__`（`llm_service.py:312-319`）：`run_in_parallel=True`、`group_parallel_tools=True`、`function_call_timeout_secs=None`、`enable_async_tool_cancellation=False`（弃用）、`settings`。

`OpenAILLMService.__init__(*, model=None, service_tier=None, params=None, settings=None, **kwargs)` — `pipecat/services/openai/llm.py:25-97`，默认 `model="gpt-4.1"`。

`OpenAILLMSettings` — `base_llm.py:50-72`：继承 `LLMSettings`（`pipecat/services/settings.py:294-347`：`model`、`system_instruction`、`temperature`、`max_tokens`、`top_p`、`top_k`、`frequency_penalty`、`presence_penalty`、`seed`、…）并加 `max_completion_tokens`；`extra: dict[str, Any]` 来自 `ServiceSettings`（`settings.py:104`）。

请求参数构造 `build_chat_completion_params` — `base_llm.py:363-396`：固定 `stream=True`、`stream_options={"include_usage": True}`，最后 **`params.update(self._settings.extra)`**（`:395`），然后 `self._client.chat.completions.create(**params)`（`:346-361`）。因此 `extra` 里的键会原样作为 OpenAI SDK 的关键字参数传入；SDK 支持 `extra_body`（`openai/resources/chat/completions/completions.py:135`）。

### 4.2 `QwenLLMService` — `pipecat/services/qwen/llm.py:24-91`

```python
QwenLLMService(*, api_key: str,
               base_url: str = "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
               model: str | None = None,          # 弃用；默认 "qwen-plus"
               settings: QwenLLMService.Settings | None = None, **kwargs)  # kwargs → OpenAILLMService
```
- `QwenLLMSettings` 只是 `BaseOpenAILLMService.Settings` 的空子类（`:17-21`）。
- `supports_developer_role = False`（`:33`）。
- **关闭 thinking**：`pipecat/` 下 grep `enable_thinking` **源码中未找到**；Qwen 服务没有专门字段。可行路径是借 `extra` 透传（源码机制见 §4.1）：

```python
llm = QwenLLMService(
    api_key=..., base_url=...,   # 国内 DashScope 的 base_url 需自己填，默认是 intl
    settings=QwenLLMService.Settings(
        model="qwen3-...",                         # 具体型号待定
        system_instruction=SYSTEM_PROMPT,
        extra={"extra_body": {"enable_thinking": False}},
    ),
)
```
`enable_thinking` 这个参数名来自 DashScope 文档而非 Pipecat 源码，**未验证**，需 live 测试确认。
- 源码中没有对 `reasoning_content` 的处理（`base_llm.py` 中只出现 `reasoning_tokens` 的用量统计，`:527-538`）。

### 4.3 `DeepSeekLLMService` — `pipecat/services/deepseek/llm.py:55-165`

```python
DeepSeekLLMService(*, api_key: str, base_url: str = "https://api.deepseek.com/v1",
                   model: str | None = None,   # 弃用；默认 "deepseek-flash"
                   settings: Settings | None = None, **kwargs)
```
- `DeepSeekLLMSettings.thinking: DeepSeekThinkingConfig | None`，默认 `DeepSeekThinkingConfig(type="disabled")`（`:35-52, 100-102`）。
- `supports_developer_role = False`、`supports_response_schema = False`、`adapter_class = DeepSeekLLMAdapter`（`:64-69`）。
- **源码观察（疑似 bug）**：把 `thinking` 写进 `extra_body` 的方法名是 `_build_chat_completion_params`（带下划线，`:131-165`），而基类调用的是 `build_chat_completion_params`（`base_llm.py:346, 443`）；全包 grep 无其他调用者。因此 `thinking` 设置**实际上不会被发出**。若要关闭 DeepSeek 思考，需要同样走 `extra={"extra_body": {"thinking": {"type": "disabled"}}}`。**未验证**。

### 4.4 `MiniMaxHttpTTSService` — `pipecat/services/minimax/tts.py:138-317`

```python
MiniMaxHttpTTSService(*, api_key: str,
                      base_url: str = "https://api.minimax.io/v1/t2a_v2",
                      group_id: str,
                      model: str | None = None,       # 弃用；默认 "speech-2.8-turbo"
                      voice_id: str | None = None,    # 弃用；默认 "Calm_Woman"
                      aiohttp_session: aiohttp.ClientSession,   # 必填
                      sample_rate: int | None = None,           # None → 管道默认
                      stream: bool = True,
                      params: InputParams | None = None,        # 弃用
                      settings: Settings | None = None, **kwargs)
```
- base_url 备选（docstring `:196-199`）：中国大陆 `https://api.minimaxi.chat/v1/t2a_v2`，美西 `https://api-uw.minimax.io/v1/t2a_v2`。实际请求 URL 是 `f"{base_url}?GroupId={group_id}"`（`:311`）。
- `MiniMaxTTSSettings`（`:94-115`）：继承 `TTSSettings`（`model`、`voice`、`language`，`settings.py:351-372`），加 `speed`、`volume`、`pitch`、`emotion`、`text_normalization`、`latex_read`、`language_boost`。默认 `speed=1.0, volume=1.0, pitch=0`，其余 None（`:248-259`）。
- 音频格式固定 `pcm`、单声道、128 kbps，采样率在 `start()` 取 `self.sample_rate`（`:313-346`）。
- 只有 HTTP 流式实现；`pipecat/services/minimax/` 下只有 `tts.py`，**无 websocket 版**。没有 `minimax` extra（依赖 aiohttp，为基础依赖）。

```python
import aiohttp
async with aiohttp.ClientSession() as session:
    tts = MiniMaxHttpTTSService(
        api_key=..., group_id=..., aiohttp_session=session,
        base_url="https://api.minimaxi.chat/v1/t2a_v2",
        settings=MiniMaxHttpTTSService.Settings(voice="...", model="speech-2.8-turbo"),
    )
```

`TTSService.__init__` 的通用参数（`pipecat/services/tts_service.py:151-197`）里与本项目相关的：`text_aggregation_mode`、`text_filters`、`text_transforms`、`skip_aggregator_types`、`sample_rate`。

### 4.5 `FunASRSTTService` — `pipecat/services/funasr/stt.py:87-199`

```python
FunASRSTTService(*, device: str = "cpu", settings: FunASRSTTService.Settings | None = None, **kwargs)
# kwargs → SegmentedSTTService
```
- **进程内、分段式**：继承 `SegmentedSTTService`；构造时 `AutoModel(model=..., device=..., disable_update=True)` 在本进程加载模型（`:126-128`）；`run_stt` 用 `asyncio.to_thread` 同步推理（`:172-181`）。
- 默认 settings：`model="iic/SenseVoiceSmall"`, **`language=Language.EN`**, `use_itn=True`（`:110-114`）——中文必须显式设 `language=Language.ZH`。
- 需要 `funasr` extra（`METADATA:79-80`），**当前 `.venv` 未安装 funasr**。
- **源码观察**：`FunASRSTTService` 没有覆盖 `wants_wav_segments`（只有 `whisper`、`moonshine` 覆盖为 False），所以收到的是 WAV（含 44 字节头），而它直接 `np.frombuffer(audio, dtype=np.int16)`（`:166`），头部会被当成约 22 个样本。影响可能很小，**未验证**。

### 4.6 自定义 STT 的基类

`STTService(AIService)` — `pipecat/services/stt_service.py:52-200`
```python
(*, audio_passthrough=True, sample_rate: int | None = None, stt_ttfb_timeout: float = 2.0,
 ttfs_p99_latency: float | None = None, keepalive_timeout: float | None = None,
 keepalive_interval: float = 5.0, settings: STTSettings | None = None, **kwargs)
```
唯一抽象方法：`async def run_stt(self, audio: bytes) -> AsyncGenerator[Frame | None, None]`（`:335-349`）。事件：`on_connected`、`on_disconnected`、`on_connection_error`。可选：`request_finalize()` / `confirm_finalize()`（`:210-233`），确认后下一个 `TranscriptionFrame` 被标 `finalized`。

`SegmentedSTTService(STTService)` — `:798-1006`
```python
(*, sample_rate: int | None = None, trailing_silence_secs: float = 0.5, **kwargs)
```
依赖 VAD 帧切段，每段 `run_stt` 一次，在后台 task 中按顺序转写（`:958-968`）；`wants_wav_segments` 默认 True（`:896-904`）；推出的 `TranscriptionFrame.finalized=True`（`:906-918`）。

`WebsocketSTTService(STTService, WebsocketService)` — `:1008-1119`
```python
(*, reconnect_on_error: bool = True, **kwargs)
```
需实现 `WebsocketService` 的三个抽象方法（`pipecat/services/websocket_service.py:399-425`）：
`async _connect_websocket()`、`async _disconnect_websocket()`、`async _receive_messages()`，外加 `run_stt`。
`WebsocketService.__init__(*, reconnect_backoff_min_wait=4.0, reconnect_backoff_max_wait=10.0, reconnect_on_error=True, ws_close_timeout=WS_CLOSE_TIMEOUT, **kwargs)`（`:100-136`）；连接用 `await self._websocket_connect(uri, **kwargs)`（`:149-166`）；接收循环 `self.create_task(self._receive_task_handler(self._report_error))` 自带重连（`:338-376`）。

参考实现套路（`pipecat/services/together/stt.py:133-357`）：`setup()` 里 `_connect()`；`run_stt` 只把音频发出去然后 `yield None`；`process_frame` 收到 `VADUserStoppedSpeakingFrame` 时发 commit；`_receive_messages` 里 `push_frame(InterimTranscriptionFrame(...))` / `push_frame(TranscriptionFrame(text, self._user_id, time_now_iso8601(), result=evt))`，推最终稿前调 `emit_stt_usage_metrics()`。

---

## 5. Context 聚合器

- `LLMContext(messages=None, tools=NOT_GIVEN, tool_choice=NOT_GIVEN)` — `pipecat/processors/aggregators/llm_context.py:91-112`；方法 `get_messages()` `:221`、`add_message` `:361`、`add_messages` `:369`、`set_messages` `:377`、`transform_messages` `:385`、`set_tools` `:396`、`set_tool_choice` `:408`。
- `LLMContextAggregatorPair` — `llm_response_universal.py:2491-2580`

```python
LLMContextAggregatorPair(context: LLMContext, *,
                         user_params: LLMUserAggregatorParams | None = None,
                         assistant_params: LLMAssistantAggregatorParams | None = None,
                         add_tool_change_messages: bool | None = None,
                         realtime_service_mode: bool | None = None)
# .user() / .assistant()，也可 user, assistant = LLMContextAggregatorPair(context)
```
- `LLMUserAggregatorParams`（`:123-187`）：`add_tool_change_messages=False`、`audio_idle_timeout=1.0`、`user_turn_strategies=None`、`user_mute_strategies=[]`、`user_turn_stop_timeout=5.0`、`user_idle_timeout=0`、`vad_analyzer=None`、`empty_user_turn=EmptyUserTurnConfig()`。用户聚合器事件：`on_user_turn_started`、`on_user_turn_stopped`、`on_user_turn_stop_timeout`、`on_user_turn_idle`、`on_user_turn_message_added`、`on_user_mute_started/stopped`（`:584-631, 665-672`）。
- `LLMAssistantAggregatorParams`（`:215-288`）：`enable_auto_context_summarization=False`、`auto_context_summarization_config=None`、`add_tool_change_messages=False`。助手聚合器事件：`on_assistant_turn_started`、`on_assistant_turn_stopped`、`on_assistant_thought`、`on_summary_applied`（`:1584-1598`）。
- **"只保留最近 N 轮"**：`pipecat/processors/aggregators/` 下 grep `keep_last|max_messages|last_n` **源码中未找到**简单截断功能。可用的内建手段：
  1. 自动摘要：`LLMAutoContextSummarizationConfig(max_context_tokens=8000, max_unsummarized_messages=20, summary_config=LLMContextSummaryConfig(target_context_tokens=6000, min_messages_after_summary=4, ..., llm=None))`（`pipecat/utils/context/llm_context_summarization.py:60-175`），通过 `LLMAssistantAggregatorParams(enable_auto_context_summarization=True, auto_context_summarization_config=...)` 启用。会额外调用一次 LLM（可用 `llm=` 指定另一个便宜模型）。
  2. 自己截断：推 `LLMMessagesTransformFrame(transform=callable, run_llm=None)`（`frames.py:749-763`），聚合器调用 `transform_messages`（`llm_response_universal.py:1267-1270`）。截断时注意别把 tool_call 与其 tool 消息拆开（推论，未验证）。

```python
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import (
    LLMContextAggregatorPair, LLMUserAggregatorParams)
from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.audio.vad.vad_analyzer import VADParams

context = LLMContext(tools=tools)
user_agg, assistant_agg = LLMContextAggregatorPair(
    context,
    user_params=LLMUserAggregatorParams(
        vad_analyzer=SileroVADAnalyzer(params=VADParams(stop_secs=0.2)),
    ),
)
```

---

## 6. 指标与 OpenTelemetry

### 6.1 `PipelineParams` — `pipecat/pipeline/worker.py:164-196`

```
audio_in_sample_rate: int = 16000        enable_metrics: bool = False
audio_out_sample_rate: int = 24000       enable_usage_metrics: bool = False
enable_heartbeats: bool = False          report_only_initial_ttfb: bool = False
heartbeats_period_secs / heartbeats_monitor_secs   send_initial_empty_metrics: bool = True
start_metadata: dict = {}
```

`PipelineWorker.__init__` 关键参数（`worker.py:274-305`）：`pipeline`、`params`、`observers`、`enable_tracing=False`、`enable_turn_tracking=True`、`enable_rtvi=None`（未桥接时默认开）、`rtvi_processor`、`rtvi_observer_params`、`conversation_id`、`additional_span_attributes`、`idle_timeout_secs`、`cancel_on_idle_timeout=True`、`app_resources`。方法：`queue_frame` `:884`、`queue_frames` `:901`、`flush_pipeline(timeout=5.0)` `:922`、`stop_when_done` `:763`、`cancel` `:830`、`add_observer` `:704`、属性 `rtvi` `:676`、`turn_tracking_observer` `:658`。

### 6.2 `MetricsFrame(data: list[MetricsData])` — `frames.py:1426-1435`；数据类型 `pipecat/metrics/metrics.py`

| 类 | 行 | 字段 |
|---|---|---|
| `MetricsData` | 19 | `processor: str`, `model: str | None` |
| `TTFBMetricsData` | 31 | `value: float`（秒） |
| `TTFAMetricsData` | 41 | `ttfa`, `ttfb`, `leading_silence`（TTS 首个可闻样本） |
| `TTFATMetricsData` | 64 | `ttfat`, `ttfb`, `thinking_time`（LLM 首个答案 token） |
| `ProcessingMetricsData` | 99 | `value: float` |
| `LLMUsageMetricsData` / `STTUsageMetricsData` / `TTSUsageMetricsData` | 151 / 181 / 191 | 用量 |
| `TextAggregationMetricsData` | 201 | 句子聚合耗时 |
| `TurnMetricsData` / `SmartTurnMetricsData` | 214 / 233 | 回合检测 |

STT 的 TTFB 定义为"VAD 停止 → 最终稿到达"（`stt_service.py:111-116`）。

### 6.3 可用于延迟打点的观察者（`pipecat/observers/`）

| 观察者 | 位置 | 事件 / 用途 |
|---|---|---|
| `UserBotLatencyObserver(*, max_frames=None(弃用), min_contribution_secs=..., time_source=time.time)` | `user_bot_latency_observer.py:510-607` | `on_latency_measured(observer, latency_seconds)`：从"用户真正停说（VAD timestamp − stop_secs）"到 `BotStartedSpeakingFrame`；`on_latency_breakdown(observer, breakdown: LatencyBreakdown)`（需 `enable_metrics=True`，含 ttfb、function_calls、contributions、`turn_contribution_lines()`）；`on_first_bot_speech_latency` |
| `ServiceMetricsObserver(*, time_source=time.time)` | `service_metrics_observer.py:121-163` | `on_service_latency(observer, ServiceLatencyRecord)`（kind=ttfb/ttfa/ttfat）、`on_service_usage(observer, ServiceUsageRecord)` |
| `TurnTrackingObserver(max_frames=None, turn_end_timeout_secs=2.5)` | `turn_tracking_observer.py:29-82` | `on_turn_started`、`on_turn_ended`（回合号、时长、是否被打断）；`enable_turn_tracking=True` 时 worker 自动加 |
| `FunctionCallObserver` | `function_call_observer.py:98-152` | `on_function_call_event` |
| `StartupTimingObserver` | `startup_timing_observer.py:170-268` | 启动耗时报告 |
| `MetricsLogObserver(include_metrics=None)` | `loggers/metrics_log_observer.py:33-90` | 把 MetricsFrame 打到日志 |
| 其它 loggers | `loggers/debug_log_observer.py`、`llm_log_observer.py`、`transcription_log_observer.py` | |

名为 `UserBotLatencyLogObserver` 的类 **源码中未找到**（grep `UserBotLatencyLogObserver|class .*LatencyLog` 无结果）。

```python
from pipecat.observers.user_bot_latency_observer import UserBotLatencyObserver
latency = UserBotLatencyObserver()

@latency.event_handler("on_latency_measured")
async def on_latency_measured(observer, latency_seconds):
    ...  # 写 logs/latency.jsonl

worker = PipelineWorker(pipeline, params=PipelineParams(enable_metrics=True, enable_usage_metrics=True),
                        observers=[latency])
```

### 6.4 Tracing

- `setup_tracing(service_name: str = "pipecat", exporter=None, console_export: bool = False) -> bool` — `pipecat/utils/tracing/setup.py:37-60`；`is_tracing_available()` `:28-34`（只看 opentelemetry 能否导入）。
- 开启：`PipelineWorker(..., enable_tracing=True, conversation_id=..., additional_span_attributes=...)`；只有 `enable_tracing and is_tracing_available()` 且开了 turn tracking 时，worker 才会自动加 `UserBotLatencyObserver` + `TurnTraceObserver`（`worker.py:445, 459-476`）。服务方法上有 `@traced_llm` / `@traced_tts` / `@traced_stt` 装饰器（如 `base_llm.py:45`、`minimax/tts.py:347`）。
- 需要 extra **`tracing`**：`opentelemetry-sdk`、`opentelemetry-api`、`opentelemetry-instrumentation`（`METADATA:196-199`）。当前 `.venv` 里已有 `opentelemetry_api 1.45.0` 及 OTLP http exporter（被其它依赖间接带入），但 `pyproject.toml` 未声明 `tracing` extra。

---

## 7. 打断与用户回合

- 打断的开关在**用户回合开始策略**：`BaseUserTurnStartStrategy(*, enable_interruptions: bool = True, enable_user_speaking_frames=None(弃用), **kwargs)`（`pipecat/turns/user_start/base_user_turn_start_strategy.py:53-78`）——回合开始时由用户聚合器发出打断。
- `UserTurnStrategies(start=None, stop=None)`（`pipecat/turns/user_turn_strategies.py:56-80`），默认：
  - start = `[VADUserTurnStartStrategy(), TranscriptionUserTurnStartStrategy()]`（`:29-42`）
  - stop = `[TurnAnalyzerUserTurnStopStrategy(turn_analyzer=LocalSmartTurnAnalyzerV3())]`（`:45-53`；模型 `smart-turn-v3.2-cpu.onnx`，`pipecat/audio/turn/smart_turn/local_smart_turn_v3.py:50`）
- 其它策略：`SpeechTimeoutUserTurnStopStrategy(*, user_speech_timeout=0.6, wait_for_transcript=True)`（`pipecat/turns/user_stop/speech_timeout_user_turn_stop_strategy.py:49-55`）；`TurnAnalyzerUserTurnStopStrategy(*, turn_analyzer, wait_for_transcript=True)`（`turn_analyzer_user_turn_stop_strategy.py:50-56`）；`MinWordsUserTurnStartStrategy(*, min_words, use_interim=True)`（`min_words_user_turn_start_strategy.py:31`）；以及 `ExternalUserTurnStrategies`、`FilterIncompleteUserTurnStrategies`、`EagerUserTurnStrategies`（`user_turn_strategies.py:83-200`）。
- 不想打断：`UserTurnStrategies(start=[VADUserTurnStartStrategy(enable_interruptions=False), ...])`（由上述签名推出，未运行）。
- 手动打断：任意处理器 `await self.broadcast_interruption()`（`pipecat/processors/frame_processor.py:1016-1025`）；`RTVIProcessor.interrupt_bot()` 就是调它（`rtvi/processor.py:144-146`）。也可推 `InterruptionWorkerFrame`，worker 会转成 `InterruptionFrame`（`frames.py:1896-1904`）。
- LLM 收到 `InterruptionFrame` 时只取消同步工具（§1.4）。

相关帧（`pipecat/frames/frames.py`）：

| 帧 | 行 | 说明 |
|---|---|---|
| `InterruptionFrame` SystemFrame | 1221 | 唯一的打断帧 |
| `UserStartedSpeakingFrame` / `UserStoppedSpeakingFrame` | 1233 / 1244 | **用户回合**开始/结束（策略决定），不是原始 VAD |
| `VADUserStartedSpeakingFrame(start_secs, timestamp)` / `VADUserStoppedSpeakingFrame(stop_secs, timestamp)` | 1325 / 1340 | 原始 VAD |
| `UserSpeakingFrame` | 1297 | 说话中周期帧 |
| `BotStartedSpeakingFrame` / `BotStoppedSpeakingFrame` / `BotSpeakingFrame` | 1391 / 1402 / 1413 | 由输出传输上下游双向发出 |
| `EagerEndOfTurnCancelFrame` | 1258 | 投机回复撤回 |

`StartInterruptionFrame`、`BotInterruptionFrame` **源码中未找到**；`InterruptionTaskFrame` 为 1.4.0 弃用别名（`frames.py:1990-1994`）。

---

## 8. 服务端 ↔ 客户端自定义消息（RTVI）

- `PipelineWorker` 默认自动在管道最前面插入 `RTVIProcessor`，并把 `RTVIObserver` 加进 observers（`worker.py:492-518, 581`）；`on_client_ready` 时自动 `set_bot_ready()`（`:520-524`）。自己再加一份会被警告。
- 协议：`MESSAGE_LABEL = "rtvi-ai"`、`PROTOCOL_VERSION = "2.1.0"`（`pipecat/processors/frameworks/rtvi/models.py:32-38`）。

**服务端 → 客户端**
- `RTVIServerMessageFrame(data: Any)` SystemFrame（`rtvi/frames.py:37-49`）。`RTVIObserver` 看到它被推出时发送 `{"label":"rtvi-ai","type":"server-message","data": ...}`（`rtvi/observer.py:587-589`；模型 `models.py:660-668`）。在工具 handler 里可写 `await params.llm.push_frame(RTVIServerMessageFrame(data={...}))`（由上述机制推出，未运行）。
- 或直接 `await worker.rtvi.send_server_message(data)`（`rtvi/processor.py:148-151`）。
- 传输层：`OutputTransportMessageUrgentFrame` → `SmallWebRTCOutputTransport.send_message` → `SmallWebRTCConnection.send_app_message`（JSON 走 data channel，`transport.py:918-926`、`connection.py:752-782`）。
- 函数调用状态也会自动发给客户端（`llm-function-call-started/in-progress/stopped`），内容由 `RTVIObserverParams.function_call_report_level`（默认 `{"*": NONE}`）控制（`observer.py:203-205`，枚举 `DISABLED/NONE/NAME/ARGUMENTS/FULL` `:98-102`）。`RTVIObserverParams` 其它开关见 `observer.py:177-205`（`bot_llm_enabled`、`user_transcription_enabled`、`metrics_enabled` 等，大多默认 True）。
- 客户端 JS 侧如何接收（如 `onServerMessage`）不在本 Python 包内，**未验证**。

**客户端 → 服务端**
- data channel 消息 → `InputTransportMessageFrame(message)`（`frames.py:1501`）→ `RTVIProcessor._handle_transport_message`，`label` 不是 `rtvi-ai` 的忽略（`rtvi/processor.py:288-299`）。同时 transport 事件 `on_app_message(transport, message, sender)` 也会收到原始消息（`transport.py:1047-1051`）。
- `type="client-message"`，`data={"t": str, "d": Any}`（`models.py:59-63`）→ 推 `RTVIClientMessageFrame(msg_id, type, data)` 并触发 `on_client_message(rtvi, RTVI.ClientMessage)`（`processor.py:323-325, 496-508`）。回复：`await rtvi.send_server_response(client_msg, data)` / `send_error_response(...)`（`:153-164`）或推 `RTVIServerResponseFrame(client_msg, data=None, error=None)`（`frames.py:52-66`）。
- `type="send-text"`，`data={"content": str, "options": {"run_immediately": True, "audio_response": True}}`（`models.py:224-241`）→ `run_immediately` 时先打断并 `flush_pipeline()`，再推 `LLMMessagesAppendFrame(messages=[{"role":"user","content":...}], run_llm=run_immediately)`；`audio_response=False` 时临时推 `LLMConfigureOutputFrame(skip_tts=True)`（`processor.py:468-494`）。这就是网页端"打字输入"的现成通道。

```python
@worker.rtvi.event_handler("on_client_message")
async def on_client_message(rtvi, msg):          # msg: RTVI.ClientMessage(msg_id, type, data)
    if msg.type == "panel-action":
        await rtvi.send_server_response(msg, {"ok": True})
```

---

## 9. 文本模式回归（用文本代替音频注入）

可选手段（均为源码中存在的 API）：

1. **`LLMMessagesAppendFrame(messages, run_llm=True)`**（`frames.py:718-731`）——用户聚合器直接 `add_messages` 并推 context（`llm_response_universal.py:1257-1260`），绕过 STT/VAD/回合策略。最稳定，等价于 RTVI `send-text`。
2. **`TranscriptionFrame(text, user_id, timestamp, language=None, result=None, finalized=False)`**（`frames.py:492-515`）——走真实的回合逻辑：`TranscriptionUserTurnStartStrategy` 开回合；默认的 SmartTurn 停止策略依赖音频，文本模式下建议换 `SpeechTimeoutUserTurnStopStrategy`，它在"没有 VAD stop 时以最后一次转写后的静默计时"（`speech_timeout_user_turn_stop_strategy.py:42-46`）。注意聚合器会丢弃空白文本（`llm_response_universal.py:1272-1277`）。
3. `LLMRunFrame()`（`frames.py:707`）——用当前 context 触发推理。
4. `TTSSpeakFrame(text, append_to_context=True)`（`frames.py:874-890`）——直接让 TTS 念。

注入方式：`await worker.queue_frame(frame)` / `await worker.queue_frames([...])`（下游从管道头部推入，`worker.py:884-920`）；要等管道排空可 `await worker.flush_pipeline()`（`:922`）。也可用 RTVI `send-text`（§8）从网页端注入。

```python
from pipecat.frames.frames import LLMMessagesAppendFrame, TranscriptionFrame
from pipecat.utils.time import time_now_iso8601

await worker.queue_frame(LLMMessagesAppendFrame(messages=[{"role": "user", "content": "什么是导数？"}], run_llm=True))
# 或走回合逻辑：
await worker.queue_frame(TranscriptionFrame("什么是导数？", "", time_now_iso8601()))
```

---

## 附：组装整条管道（按源码拼装，未运行）

```python
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.worker import PipelineParams, PipelineWorker
from pipecat.workers.runner import WorkerRunner

pipeline = Pipeline([
    transport.input(), stt, user_agg, llm, tts, transport.output(), assistant_agg,
])
worker = PipelineWorker(pipeline, params=PipelineParams(enable_metrics=True, enable_usage_metrics=True),
                        observers=[latency])

@transport.event_handler("on_client_disconnected")
async def on_client_disconnected(transport, client):
    await worker.cancel()

runner = WorkerRunner(handle_sigint=runner_args.handle_sigint)
await runner.add_workers(worker)
await runner.run()
```
`Pipeline(processors: Sequence[FrameProcessor], *, ...)` — `pipecat/pipeline/pipeline.py:91-102`；`WorkerRunner(*, name=None, bus=None, handle_sigint=True, handle_sigterm=False, force_gc=False, check_dangling_tasks=True, loop=None, task_manager=None)` — `pipecat/workers/runner.py:109-135`。

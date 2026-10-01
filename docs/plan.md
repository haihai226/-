# Pipecat × DeepTutor 语音家教整体方案

Oct 2, 2026 · @CIHai

## 目标与边界

做一个能用语音实时对话的 AI 家教：Pipecat 负责听和说，DeepTutor 负责教材、记忆和出题，两者靠异步工具协议衔接。学生说完到听见回应 ≤ 1.2 秒，教材查询在后台跑，对话不中断。

第一版要做：

- 全双工语音对话：可打断、有过渡语、后台查教材
- 基于学生自己教材的讲解、追问和出题（DeepTutor 知识库 RAG）
- 跨会话记忆：知道学生学过什么、错在哪
- 一块伴随屏幕：题目、公式、图在网页上同步显示

第一版不做：

- 不改 Pipecat 或 DeepTutor 内部代码，只用公开 API 和 CLI
- 不做多老师人设切换，不上 Subagents 分布式
- 不做电话接入和数字人，先做网页 + WebRTC
- 不自研任何语音模型

| 指标 | 目标 | 怎么量 |
| --- | --- | --- |
| 学生说完到首个音频帧 | P50 ≤ 1.2 s，P95 ≤ 2 s | Pipecat OpenTelemetry 指标 |
| 快模型首 token | P50 ≤ 500 ms | 同上 |
| 教材查询的过渡语 | ≤ 1 s 内说出 | 同上 |
| 教材查询最终结果 | P95 ≤ 20 s，超 30 s 走超时话术 | 工具日志 |
| 打断后停止播放 | ≤ 300 ms | 同上 |
| 记忆写入 | 每轮后 L1 trace 落盘，不阻塞回答 | DeepTutor memory show |
| 可朗读 | 抽检 50 轮，0 条含 Markdown 或公式符号 | 人工抽检 |

## 总体架构

三层：学生端只管音频和屏幕，voice-agent 里的快模型在前台接话，DeepTutor 作为异步工具在后台查教材、出题、记记忆。耦合只在快模型旁边的适配层，一个文件。

（图：总体架构 · 学生端、voice-agent、DeepTutor 三层，见方案文档原件）

音频经传输层进出，教材查询和出题走快模型到 ChatOrchestrator 的 SSE 调用，结果拆成念的 speak 和看的 show；TTS 的音频同样经传输层回到学生端。

## 实时层：Pipecat 管道

管道里的快模型只负责接话、追问和过渡语，所有重活走异步工具。管道按下面的顺序串：

1. 传输：SmallWebRTCTransport 自托管，不依赖 Daily；弱网或移动端回退到 WebSocket Server 传输
2. VAD：Silero，本地运行；嘈杂环境加 RNNoise
3. STT：FunASR，中英混合识别好，可本地部署
4. 上下文聚合：只保留本会话最近 10 轮 + 一段 ≤ 300 字的学生画像
5. 快模型：Qwen3 非 thinking 模式，经 Pipecat 的 OpenAI 兼容服务接入，只挂 3 个工具
6. TTS：MiniMax 流式，首包快
7. 清洗与屏幕消息处理器：去掉残留符号，把"屏幕内容"推给前端（见第 6 节）

| 环节 | 首选 | 备选 | 备注 |
| --- | --- | --- | --- |
| 传输 | SmallWebRTCTransport | FastAPI WebSocket | 自托管，国内不需要 Daily |
| VAD | Silero | — | 本地运行 |
| STT | FunASR | Deepgram、Azure | FunASR 本地部署可零外网 |
| 快模型 | Qwen3（非 thinking） | DeepSeek-V3、GPT-4.1-mini | 必须支持函数调用 |
| TTS | MiniMax | Fish Audio、Azure | 看流式首包延迟 |
| 噪声抑制 | RNNoise | Krisp Viva | 可选 |

快模型的系统提示写死五条规则：

- 口语、短句，一次只问一个问题
- 教材内容、学生历史、题目只能来自工具结果，工具没返回之前不编
- 调工具的同时说一句过渡语，例如"我翻一下教材"
- 工具结果到了用一两句话转述，不读原文
- 学生改了问题就调用取消工具，只是打断播放则不取消

结构化课程流程（讲、问、测、评）留到第四阶段用 Pipecat Flows 承载，第一版靠系统提示和 DeepTutor 的 Mastery Path 状态驱动。

## 大脑层：DeepTutor 语音 Partner

在 DeepTutor 里建一个专用 Partner，叫 voice-tutor，所有语音请求都进它的工作区。这样 session、记忆、知识库天然隔离，不会污染网页端的学习记录。

| 配置项 | 设置 | 原因 |
| --- | --- | --- |
| 模型 | 非 thinking 的快模型（Qwen3 或 DeepSeek-V3），关掉 thinking 路由 | 推理模型首 token 慢，语音等不起 |
| 工具 | 只留 rag、read\_memory、write\_memory、write\_note；关掉 ask\_user、web\_search、exec | 工具越少轮次越少，一个 turn 控制在 2 轮内 |
| 知识库 | 一门课一个 KB，用 LlamaIndex 引擎（本地向量 + BM25） | 查询最快；GraphRAG 留给离线生成 Book |
| 文档解析 | PyMuPDF4LLM | 轻，不依赖 MinerU 模型下载 |
| SOUL.md | 可朗读约束 + 教学风格（先结论后理由，一次一问，追问而不是直接给答案） | 见第 6 节 |
| Persona | teacher 预设 + EduHub 的 socratic-tutor skill | 不用自己写教学法 |
| Session | 每个学生固定一个 session\_id，由 Pipecat 侧按用户 id 映射 | 记忆与上下文跨次连续 |
| 调用方式 | Partner 的 HTTP/SSE 接口；开发期用 `deeptutor run chat --format json` 的 NDJSON 替代 | SSE 可流式、可中止 |

语音侧三个工具分别对应 DeepTutor 的一个 capability：

| 语音工具 | DeepTutor capability | 传入 |
| --- | --- | --- |
| consult\_tutor | chat + rag | 学生原话、当前知识点、session\_id、kb |
| quiz\_me | deep\_question | 知识点、题数（≤ 3）、题型（选择或口答） |
| explain\_step（第四阶段） | mastery\_path | 当前步骤 id |

三个工具的返回统一成两个字段：speak（给 TTS 念的纯文本，≤ 120 字）和 show（给屏幕的 Markdown 或题目 JSON）。字段拆分在 SOUL.md 里要求 DeepTutor 直接输出，适配层只做兜底清洗。

## 衔接层：异步工具协议

快模型挂三个工具，两个是异步的：调用后对话继续，结果以"中间更新"和"最终结果"两种形式回流，并且只在学生和 bot 都空闲时才播出。

| 工具 | 类型 | 超时 | 备注 |
| --- | --- | --- | --- |
| consult\_tutor | 异步，`cancel_on_interruption=False` | 30 s | 学生打断播放不取消，换了问题才取消 |
| quiz\_me | 异步，同上 | 30 s | 题目先推屏幕，再念题干 |
| cancel\_async\_tool\_call | Pipecat 内置，`enable_async_tool_cancellation=True` 自动挂上 | — | 快模型按系统提示调用 |

六条协议规则：

- 过渡语在发起工具调用的同一轮回复里说出，不等工具
- 工具开始 3 秒后仍无最终结果，推一次 `is_final=False` 的中间更新，内容取自 DeepTutor SSE 流里的 tool\_result 事件（例如"找到教材 3.2 节了"），之后每 8 秒最多一次
- 中间更新和迟到的最终结果先进一个小队列，只在学生没在说话且 bot 没在播时交给快模型；同一工具只保留最新一条
- 同一问题的 consult\_tutor 还在跑时不发起第二次，系统提示约束 + 适配层按问题哈希拦截
- 30 秒没收到 done，返回"这个要多想一会儿，先继续"，SSE 不断开，结果到了按空闲规则播
- 学生换了问题，快模型调 cancel\_async\_tool\_call，适配层关闭 SSE 并通知 DeepTutor 中止该 turn（中止语义第二阶段验证）

| 环节 | 预算 | 累计 |
| --- | --- | --- |
| VAD 判停 | 250 ms | 0.25 s |
| STT 终稿 | 300 ms | 0.55 s |
| 快模型首 token | 400 ms | 0.95 s |
| TTS 首包 | 250 ms | 1.2 s |
| DeepTutor 工具 | 3–20 s，由过渡语和中间更新遮蔽 | 不计入 |

（图：一轮带教材查询的对话 · 主流程 8 步，3 个分支，见方案文档原件）

主流程里学生最多等 1 秒就听到回应；三个分支分别处理打断、换问题和超时，只有换问题会真正取消 DeepTutor 的 turn。

## 可说性与屏幕联动

语音念的和屏幕显示的是两条流：DeepTutor 的 Markdown 原文走屏幕，语音只播可朗读的 speak 字段。靠三层保证：

1. 源头约束（SOUL.md）：每句 ≤ 20 字，一次只问一个问题；禁用 Markdown 标记、LaTeX、代码块、引用编号；公式用口语读法；先结论后一句理由
2. 兜底清洗（Pipecat 处理器）：去掉残留的 #、\*、\`\`\`、$ 和 \[1\] 式引用；列表改成"第一、第二"；数字和单位规范化
3. 屏幕联动：工具结果的 show 字段通过 Pipecat 客户端消息推到前端，前端用一个轻量面板渲染题卡、公式、图

| 内容类型 | 语音怎么说 | 屏幕怎么显示 |
| --- | --- | --- |
| 公式 | 口语化读法，如"x 的平方加二 x" | KaTeX 渲染 |
| 选择题 | 念题干和 ≤ 4 个选项的要点 | 题卡，可点选作答 |
| 代码 | 只说思路 | 代码块 |
| 图和可视化 | "你看屏幕上这张图" | DeepTutor Visualize 输出的 SVG 或 HTML |
| 教材引用 | 不念 | 显示来源页码 |

前端第一版不改 DeepTutor 的 Next.js，用 Pipecat 的 React 客户端 SDK 加一个面板页；学生在屏幕上点选的答案作为文本消息回传管道，由快模型转交 quiz\_me 判分。

## 记忆与预取

语音 turn 永远不等记忆写入；预取把 Mastery Path 下一步的讲解和题目提前算好，这是语音家教相对开放域聊天最大的红利。

记忆分两速，照 Letta 的做法：小模型小上下文在前台，大模型在后台整理。

- 会话开始时从 DeepTutor L3 读一次学生画像，压成 ≤ 300 字放进快模型的系统提示
- 每轮结束，适配层异步写一条 L1 trace（学生问了什么、答对没、卡在哪），不等返回
- L2、L3 的合并交给 DeepTutor 自带的 consolidator 后台跑，预算在 Settings → Memory 里调低频率
- 快模型的上下文只保留本会话最近 10 轮，超出的靠 DeepTutor 的记忆而不是靠长上下文

预取的规则：

- 学生进入 Mastery Path 第 k 步时，后台触发第 k+1 步的 chat（讲解）和 deep\_question（2 到 3 题），结果写入缓存，key 为学生 id + 步骤 id
- consult\_tutor 和 quiz\_me 先查缓存，命中则 1 秒内返回
- 缓存有效期一节课（2 小时），学生跳步或换知识点即作废
- 第一版用进程内字典，第四阶段换 Redis

预取的依据是 Letta 的 sleep-time compute：预测可能的问题、提前算好关键推理，查询时延迟和成本都降。辅导场景下一步讲什么是定好的，预测准确率远高于客服场景。

## 部署方案

三个容器一条内网，只有语音传输和网页对外，DeepTutor 的 API 不出内网。

| 容器 | 内容 | 端口 | 对外 |
| --- | --- | --- | --- |
| voice-agent | Pipecat 管道、三个工具、清洗处理器、面板页静态文件 | 7860（WebRTC 或 WS） | 是，经 TLS 反代 |
| deeptutor | 官方镜像 ghcr.io/hkuds/deeptutor，锁定 tag | 3782（网页）、8001（API） | 网页是，API 只内网 |
| funasr | FunASR 服务端 | 10095 | 否 |
| coturn | TURN 服务，穿透校园和公司网络 | 3478 | 是 |
| redis（第四阶段） | 预取缓存 | 6379 | 否 |

运维约束：

- 版本锁定：pipecat-ai 固定小版本，DeepTutor 固定镜像 tag；两边升级前都跑一遍 10 轮脚本对话的回归
- DeepTutor 关掉代码沙箱（sandbox\_allow\_subprocess=false），语音场景不需要生成 office 文件
- 模型 API key 只放在 voice-agent 的环境变量和 deeptutor 的 settings 文件里，前端拿不到
- STT、TTS、LLM 全部选国内可达的供应商或本地部署，不走海外 WebRTC 服务
- 观测：Pipecat 的 OpenTelemetry 指标接到 Grafana 看延迟分布；DeepTutor 的 audit/usage.jsonl 看每个学生的调用量
- 多学生：第一版 DeepTutor 单用户模式，靠 Partner 工作区内的 session\_id 区分学生；给机构部署时再开 DeepTutor 的多用户和管理员授权

## 实施路线

六周四个阶段，每段过了门槛才接下一段；第四周的异步化是整个方案的核心，前两段都是为它把底子打好。

（图：实施路线 · 四个阶段，每段一道门槛，见方案文档原件）

工时按一个全职开发者估算；第二段先用阻塞调用是故意的，先把内容和记忆这两件事验明白，再动并发。

## AI 开发工作流

开发者攥住三样东西：规格、接口、验收；AI 负责写代码。控制靠约束和验证，不靠盯着每一行。

仓库根目录放一份 CLAUDE.md（Codex 读 AGENTS.md，内容相同），AI 每次开工先读它，里面只写硬规则：

```markdown
# 项目：Pipecat × DeepTutor 语音家教
- 架构见方案文档；不改 Pipecat 和 DeepTutor 源码，所有耦合只在 adapter/ 目录
- 工具接口以 contracts.py 为准，改接口先问我
- 不许用同步调用或 sleep 来"修"延迟，只能靠异步工具和预取
- 不确定 Pipecat 的 API 时读 .venv 里的源码或 docs.pipecat.ai/llms.txt，不许凭记忆猜
- 每个任务：先出计划等批准，再写测试，再写实现；pytest 全绿才算完
- 不加新依赖，不碰密钥、端口、沙箱配置
```

"读源码不许猜"最常被违反：两个项目都在快速迭代，训练数据里的 API 多半是旧的。

| 由你定，AI 只能照着实现 | 由 AI 做，你看证据 |
| --- | --- |
| contracts.py 里的工具签名和返回字段 | 适配层、清洗处理器、面板页的实现 |
| 适配层对 DeepTutor SSE 事件的映射表 | 测试用例和假 DeepTutor 回放服务器 |
| 语音 Partner 的 SOUL.md，这是产品不是代码 | 文档、脚本、Docker 配置 |
| 供应商、密钥、端口、沙箱开关、延迟预算和门槛数字 | PR 描述里的测试输出、延迟数字、截图 |

测试是方向盘：让 AI 先写测试，你审测试、不审实现。必须有的几组：

| 测试 | 覆盖什么 | 对应门槛 |
| --- | --- | --- |
| 假 DeepTutor 回放 | 录一段真实 NDJSON 流离线回放，适配层解析不依赖线上服务 | 阶段二 |
| 可朗读清洗 | 50 条 Markdown 输入，输出零符号 | 阶段二 |
| 空闲投递队列 | 中间更新只在双方空闲时出队，同一工具只留最新一条 | 阶段三 |
| 取消语义 | 换问题触发取消；打断播放不取消；取消后迟到结果被丢弃 | 阶段三 |
| 10 轮脚本对话回归 | 端到端跑通，打印各环节延迟 | 每个阶段 |

工作方式四条：

- 环境先由你亲手跑通一次：docker compose 起 DeepTutor，`pipecat init` 把项目做成 agent-ready，装 Pipecat 官方的 Claude Code skills（`claude plugin marketplace add pipecat-ai/skills`），把 DeepTutor 根目录的 SKILL.md 放进上下文。跑不起来的 AI 会编造"测试通过"
- 一个任务一个分支一个新会话，上下文不拖长；任务的"做完"直接抄方案里的门槛
- 超过五个文件的改动先出计划再动手
- 看 diff 不看聊天：PR 里要 AI 贴证据，你抽查两处

## 风险与对策

最大的两个风险是 DeepTutor 接口变动和单轮太慢，都靠"耦合只放在适配层"和"工具集最小化"来兜。

| 风险 | 影响 | 对策 |
| --- | --- | --- |
| DeepTutor 迭代快（7 个月 50 多个版本），接口变动 | 工具调用失败 | 锁镜像 tag；适配层单文件，只碰 SSE 和 CLI；10 轮回归脚本 |
| DeepTutor 单轮超过 30 秒 | 对话冷场 | 工具集砍到 4 个；非 thinking 模型；超时话术；预取 |
| 快模型用自己的知识冒充教材 | 讲错 | 系统提示硬约束；工具未返回不许答事实；每周抽检 50 轮 |
| 输出念出 Markdown 或公式符号 | 体验差 | SOUL.md 约束 + 清洗处理器 + 抽检门槛 |
| 重复调工具、迟到结果乱插 | 对话错乱 | 问题哈希去重；空闲投递队列 |
| 中止语义不可靠，取消后 DeepTutor 仍在写记忆 | 记忆脏数据 | 第二阶段验证 Stop；不可靠则取消时只丢弃结果，并给该 turn 打作废标记 |
| 校园和公司网络 WebRTC 不通 | 连不上 | 自建 TURN；WebSocket 回退 |
| 语音 API 按量计费 | 单位成本高 | 快模型用小模型；TTS 只念 speak 字段；预取减少重复调用 |
| 学生对话和记忆的隐私 | 合规 | 不存原始音频；记忆是文件型，可查看可删除；机构部署开多用户隔离 |

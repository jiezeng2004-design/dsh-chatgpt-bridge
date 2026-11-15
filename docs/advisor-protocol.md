# advisor 模式协议

状态:已实现,尚未发布,也没有和真实 ChatGPT、OpenAI 隧道联调。适用于 `mode: advisor`。

advisor 模式下,DSH agent 负责执行(改文件、跑命令、测试、Git),ChatGPT 只能通过只读 MCP 工具查看工作区,负责规划与审查。两边通过 bridge 进程内的任务状态机交换**状态**,不交换文件内容。

## 1. 开启方式

在 DSH profile 的 `cordis.patch.yml` 里,把 bridge 行的配置改成:

```yaml
config:
  mode: advisor            # 默认 controller
  advisorMaxIterations: 12 # 每个任务的计划/执行轮数上限,1–50
```

改完重启 DSH。`controller` 模式(默认)的 23 个工具和行为完全不变。

## 2. 两边的工具

ChatGPT 一侧(MCP,共 12 个):

| 工具 | 作用 |
|---|---|
| `dsh_health`、`dsh_list_workspaces` | 与 controller 模式相同,只读 |
| `dsh_advisor_workspace_info` | 工作区名称、路径、分支、HEAD、脏文件数 |
| `dsh_advisor_list_dir` | 列目录,深度 ≤3,条目 ≤500 |
| `dsh_advisor_read_file` | 按行读文本,每次 ≤400 行、≤64 KiB |
| `dsh_advisor_search` | 文本搜索,≤100 条;正则只走 ripgrep |
| `dsh_advisor_git_status` | Git 状态,≤500 条 |
| `dsh_advisor_git_diff` | 过滤后的 diff,按字节分页,每页 ≤64 KiB |
| `dsh_advisor_wait_request` | 长轮询下一条待处理请求,单次 ≤100 秒 |
| `dsh_advisor_submit_plan` | 对 INIT 提交第一份计划 |
| `dsh_advisor_submit_verdict` | 对 EXECUTED/HANDOFF 给出 `done`、`blocked` 或下一份计划 |
| `dsh_advisor_test_status` | 读取 DSH 上报的执行与测试元数据 |

DSH agent 一侧(agent 工具,由 bridge 在 advisor 模式下注册,另带 `chatgpt-advisor` skill):

| 工具 | 作用 |
|---|---|
| `advisor_init` | 用目标创建任务,返回 `task_id` |
| `advisor_get_plan` | 长轮询等待计划或审查结论,单次 ≤100 秒 |
| `advisor_executed` | 上报改动文件数、测试结果、简短总结 |
| `advisor_handoff` | 需要 ChatGPT 或用户介入时交回控制 |

## 3. 状态机

```text
            submit_plan           advisor_get_plan        advisor_executed
  INIT ───────────────► PLAN ───────────────► EXECUTING ───────────────► EXECUTED
                          ▲                                                  │
                          │            submit_verdict(plan)                  │
                          └──────────────────────────────────────────────────┤
                                                                             │ submit_verdict(done)    → DONE
                                                                             │ submit_verdict(blocked) → BLOCKED
                                                                             │ 达到迭代上限            → BLOCKED(iteration_limit)

  PLAN / EXECUTING / EXECUTED ──advisor_handoff──► HANDOFF ──submit_verdict──► PLAN | DONE | BLOCKED
  非终态任务闲置超过 24 小时 → ERROR(expired)
```

- DONE、BLOCKED、ERROR 是终态。终态任务保留 7 天后删除。
- `iteration` 从 1 开始,每份新计划加 1。所有提交都要带当前 `iteration`,对不上返回 `STALE_ITERATION`。
- 待处理请求由任务状态推出来(INIT、EXECUTED、HANDOFF 即待处理),不是单独的队列。`wait_request` 在请求被回答前会重复返回同一条,所以隧道丢一次响应不会丢请求,进程重启后也能续上。`request_id` 固定为 `<task_id>:<iteration>:<kind>`。
- `advisor_get_plan` 同理:任务已在 EXECUTING 时再调一次,会原样返回当前计划并带 `redelivered: true`,状态不变。这样 DSH 丢了一次响应或重启后,仍能拿回执行指令。

## 4. 一轮循环

```text
DSH:  advisor_init(goal)                  → INIT
GPT:  dsh_advisor_wait_request            ← 拿到 INIT
GPT:  read_file / search / git_diff …     ← 自己读代码
GPT:  dsh_advisor_submit_plan(iteration=1) → PLAN
DSH:  advisor_get_plan                    ← 拿到计划 → EXECUTING
DSH:  执行、跑测试
DSH:  advisor_executed(iteration=1, …)    → EXECUTED
GPT:  dsh_advisor_wait_request            ← 拿到 EXECUTED
GPT:  git_diff / test_status              ← 审查
GPT:  dsh_advisor_submit_verdict(done | blocked | plan)
```

ChatGPT 每次提交后应在同一轮回复里立刻再调 `dsh_advisor_wait_request`;返回 `continuation_required: true` 时不要结束这一轮,除非需要用户介入。

## 5. 消息格式与限额

- 控制消息**只放状态**:目标、计划条目、测试名与结果、改动文件数、简短总结和原因。文件内容、diff、日志、密钥一律不放。代码由 ChatGPT 通过只读工具自己读。
- 每个字符串字段 ≤2048 字符,每个数组 ≤50 项。计划字段:`rationale`、`actions[]`、`files_likely[]`、`tests[]`、`success_criteria[]`。测试状态:`passed`、`failed`、`skipped`、`not_run`。
- 长轮询默认 90 秒,硬上限 100 秒,给 OpenAI 隧道 120 秒的请求上限留余量。
- 任务持久化在 `$DSH_HOME/chatgpt-bridge/advisor/<task_id>.json`,原子写入(临时文件后改名)。`task_id` 格式固定为 `adv_` 加 16 位十六进制,用于路径前先校验。
- 一个 DSH 会话同一时间只能有一个未结束的任务;其他会话不能操作它(`TASK_NOT_OWNED`)。

## 6. 只读数据面的安全边界

- 工作区只能是 DSH 已注册的工作区(`Bridge.resolveWorkspace`),不接受任意路径。
- 路径:拒绝空值、空字节、绝对路径(含盘符、UNC)、`..` 段和冒号;再做 `isPathInsideWorkspace` 和 realpath 包含检查,防符号链接逃逸。Windows 下大小写不敏感。
- 敏感文件(读取、列目录、搜索、Git 状态、diff 都走同一道门):`.env*`(`.env.example` 除外)、`.git` 内部、`.ssh`、`.aws`、`.azure`、`.gnupg`、`.kube`、`.docker`、`.config/gcloud`、私钥(`id_rsa*` 等)、`.npmrc`、`.pypirc`、`.netrc`、`.git-credentials`、`credentials*`、`*.pem`、`*.key`、`*.p12`、`*.pfx` 等证书与密钥库。工作区根目录的 `.dshadvisorignore` 可以追加规则(每行一个 glob,`#` 为注释)。
- 读文件:拒绝二进制和大于 10 MiB 的文件;搜索跳过大于 1 MiB 的文件。
- 正则搜索只用 ripgrep(线性时间引擎);没有 ripgrep 时只支持纯文本搜索,避免恶意正则卡死 bridge 进程。
- Git 只用 `execFile` 调用固定的只读子命令(`status`、`diff`、`rev-parse`、`branch --show-current`),关闭 fsmonitor、外部 diff 和 textconv,不写可选锁。`base` 参数先过格式检查,再用 `rev-parse --verify --end-of-options` 解析成提交号,防选项注入。
- 所有输出经 `redactValue` 脱敏。
- 已知边界:`git status`/`git diff` 仍会执行仓库自己配置的 clean/smudge 过滤器(与用户自己运行 git 相同)。advisor 模式不额外放大这一点,但仓库配置本身应当可信。

## 7. ChatGPT 侧要求(2026-11-14 查证)

- OpenAI 帮助中心说,自定义 MCP 服务器连接和完整 MCP 支持面向 ChatGPT web 的 **Business** 与 **Enterprise/Edu**。Business 只有管理员和所有者能创建;Enterprise/Edu 可以用 RBAC 授权给成员。个人套餐(Plus、Pro)是否可用、能否调用写操作,官方页没有写明,社区说法不一,**未验证**。
- `dsh_advisor_submit_plan` 和 `dsh_advisor_submit_verdict` 标注为非只读(它们改的是 bridge 里的任务状态,不碰工作区),ChatGPT 可能按应用权限要求用户确认。
- OpenAI Secure MCP Tunnel:单次请求 120 秒上限,每隧道每分钟 600 次请求,单次请求或响应 ≤10 MiB。

来源:[Connecting custom MCP servers in ChatGPT](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt)、[Secure MCP Tunnels](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels.md)。

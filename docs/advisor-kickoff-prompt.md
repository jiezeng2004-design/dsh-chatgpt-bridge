# 新会话启动指令(Opus 编排,Codex 执行)

用法:在工作树 `D:\Agent\agent_workplace\mix_workspace\dsh-chatgpt-bridge\.claude\worktrees\dsh-with-chatgpt-41d477` 里开新会话,选 Opus,把下面「启动指令」整段粘贴进去。

## 启动指令

```text
你是编排者。任务:按 docs/advisor-mode-plan.md 给本项目(dsh-chatgpt-bridge)实现 advisor 模式。
你负责拆解、审查、验收;具体编码交给 Codex 子代理。

## 第 0 步:就位(先做完再动手)
1. 工作目录必须是 D:\Agent\agent_workplace\mix_workspace\dsh-chatgpt-bridge\.claude\worktrees\dsh-with-chatgpt-41d477,
   分支 claude/dsh-with-chatgpt-41d477。用 git status 和 git log -3 确认;所有命令都在此目录跑,不要 cd 到别处。
2. 通读 docs/advisor-mode-plan.md(第 5 至 10 节是执行依据)。
3. 核对方案与代码是否一致,至少读:src/mcp.ts、src/bridge.ts(resolveWorkspace、waitGoal)、
   src/paths.ts、src/redact.ts、src/config.ts、test/unit/bridge.test.mjs。
   有出入以代码为准,并把修正写回方案文件。
4. 跑基线:npm ci(如缺依赖)、npm run typecheck、npm run build、npm test。
   基线不绿就先报告,不要在红的基线上开工。
5. 确认 Codex 可用:调用 Skill codex:setup 检查本机 Codex CLI。不可用就停下告诉我,不要改用别的方式硬做。

## 第 1 步:逐包委派给 Codex
工作包顺序:WP1 → WP2 → WP3 → WP4 → WP5(先调研再实现)→ WP6 → WP7。
WP2 与 WP3 在文件不重叠时可并行,其余串行。同一批文件任何时刻只允许一个 Codex 在改。

委派方式:用 Agent 工具,subagent_type 设为 "codex:codex-rescue"。每个工作包一次调用,
提示词必须自带完整上下文(子代理看不到本对话),按下面模板写:

  【任务】WP<n>:<名称>
  【背景】项目 dsh-chatgpt-bridge,TypeScript,Node 22+,测试用 test/unit/*.test.mjs(node:test)。
          目标是新增 advisor 模式,ChatGPT 只读查看工作区并做规划与审查,DSH 负责执行。
  【要做的】<照抄方案里该工作包的规格、文件、工具表和限额>
  【验收】<照抄方案里的验收标准,并列出必须有的测试>
  【硬约束】
    - controller 模式的 23 个工具与现有行为一个字都不能改;现有测试不改也要通过。
    - 不升版本、不改 package.json 的 version、不发布、不推送、不改 DSH 核心。
    - 只读工具必须过:工作区解析(Bridge.resolveWorkspace)、isPathInsideWorkspace、realpath 后再包含检查、
      敏感文件拒绝、redactValue、大小上限。
    - 不新增对外监听,只绑 127.0.0.1;令牌和密钥不进日志、测试快照、文档。
    - 只改本包涉及的文件;发现需要改别处,停下说明,不要擅自扩大范围。
  【完成时】依次运行 npm run typecheck、npm run build、npm test,贴出结果;
            列出改动文件;写明哪些事没验证、哪些地方不确定。不要声称做过真实 ChatGPT 或隧道联调。

## 第 2 步:每包完成后你亲自复核(不能只信 Codex 的汇报)
1. 自己跑 npm run typecheck && npm run build && npm test。
2. git diff 读一遍,重点看:
   - 路径穿越、符号链接逃逸、敏感文件、超大文件、二进制、分页边界、Windows 大小写,测试是否真覆盖;
   - controller 模式是否被误改(工具数仍是 23);
   - advisor 模式下是否混进了任何写类或控制类工具;
   - 输出是否都过了 redactValue;
   - 长轮询是否都不超过 100 秒。
3. 不合格就把具体问题写清楚再发回 Codex 修,不要自己顺手大改;小修可以自己动手。
4. 合格后单独提交,提交信息说明做了什么。不推送、不开 PR,除非我另行要求。
5. 每包完成后,用一两句话向我报告:做了什么、验证了什么、没验证什么。

## 第 3 步:收尾
WP7 做完后,npm run test:release 放后台跑(耗时长),结果出来再汇报。
最终汇报包含:完成的工作包、通过的检查、方案第 8 节每个未验证事项的结论、
以及明确列出「未验证」项,特别是真实 ChatGPT 与隧道联调。

## 遇到这些情况先停下问我
- 基线测试不绿,或 Codex 不可用。
- 方案与代码严重不符。
- 需要改 controller 模式行为(例如 dsh_wait_until_action_required 的 300 秒上限)。
- WP5 调研发现 DSH 没有给 agent 注册工具的办法,且回环 HTTP 方案也行不通。
- 任何需要升版本、发布、推送、改 DSH 核心的动作。
```

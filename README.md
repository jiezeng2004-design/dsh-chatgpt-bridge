# dsh-chatgpt-bridge

[![M8ven Score](https://m8ven.ai/badge/mcp/jiezeng2004-design-dsh-chatgpt-bridge-14d0zo)](https://m8ven.ai/mcp/jiezeng2004-design-dsh-chatgpt-bridge-14d0zo)

> **Let ChatGPT drive your local DSH agents.**
>
> 在 ChatGPT 里创建任务、继续会话、监督 Goal、处理审批并检查结果，不用在 ChatGPT 和 DSH 之间反复复制 Prompt。

`dsh-chatgpt-bridge` connects **ChatGPT Web → secure MCP tunnel → DeepSeek Harness (DSH)**. ChatGPT becomes the control surface; DSH keeps the agent loop, tools, skills, subagents, workflows, sandbox, approvals and workspace security model.

**The bridge connects the two sides. It does not replace DSH, modify DSH core, or route DSH model traffic through ChatGPT.**

Version **0.6.0** targets DSH **0.1.7-rc.2** exactly (the official npm `latest` at verification, itself a release candidate). Other DSH channels are outside this version's tested range. After a successful connection, ChatGPT should see **tool count = 23**. See the [compatibility evidence](docs/dsh-compatibility-2026-09-28.md).

## Why this exists

A normal ChatGPT + local-agent workflow has too much manual glue:

```text
Think in ChatGPT
      ↓
copy prompt to DSH
      ↓
wait / inspect logs
      ↓
copy result back
      ↓
review in ChatGPT
      ↓
repeat
```

With the bridge:

```text
ChatGPT Web
   ↓  create / continue / supervise / approve
Secure MCP tunnel
   ↓
dsh-chatgpt-bridge
   ↓
DeepSeek Harness
   ↓
local workspace + tools + agent runtime
```

You stay in ChatGPT while DSH remains the execution engine.

## What you can do from ChatGPT

- create and inspect native DSH sessions;
- send follow-up instructions without copying context between apps;
- start, inspect, update and wait on Goals;
- approve DSH actions through the bridge when your DSH policy requires it;
- list registered workspaces and inspect runtime health;
- keep using DSH's own sandbox, approval and workspace boundaries;
- manage the supported tunnel runtime from the DSH Web settings UI.

## Real setup

![DSH Web ChatGPT Bridge settings running in a real installation](assets/screenshots/06-native-settings-real-use.png)

The screenshot is from a real DSH Web installation with sensitive values masked.

## Quick start

### Requirements

- Node.js 22+
- DeepSeek Harness `0.1.7-rc.2` (`dsh` on `PATH`)
- a DSH Web profile/runtime
- ChatGPT access that can use the currently supported MCP/custom-app connection flow

### 1. Install the plugin

Install v0.6.0 into the matching DSH 0.1.7-rc.2 host:

```bash
dsh plugin --profile web add dsh-chatgpt-bridge@0.6.0
```

To install from a reviewed source checkout instead:

```bash
npm ci
npm run typecheck
npm run build
npm test
npm run test:release
pnpm dlx @deepseek-ai/dsh@0.1.7-rc.2 plugin --profile web add "file:$PWD"
```

Source installation into a real profile was not part of release verification. Back up the profile before upgrading DSH: DSH owns V3 session migration. `npm install dsh-chatgpt-bridge` alone is not enough: the plugin must be added to a DSH profile bundle. Published v0.5.1 remains tied to the older DSH 0.1.1-rc.2 host.

### 2. Start DSH Web

```bash
dsh web
```

Keep DSH Web and the bridge in the **same web profile/runtime** so ChatGPT-created sessions appear live in the UI.

Default local endpoints:

| Service | Endpoint |
| --- | --- |
| DSH Web | `http://127.0.0.1:3080` |
| Bridge MCP | `http://127.0.0.1:3456/mcp` |

### 3. Read the bridge token

Windows PowerShell:

```powershell
Get-Content "$HOME\.dsh\chatgpt-bridge.token"
```

macOS / Linux:

```bash
cat ~/.dsh/chatgpt-bridge.token
```

Treat this token like a password. Do not commit it, post it, or paste it into public chats.

Alternatively, set `DSH_CHATGPT_BRIDGE_TOKEN` yourself and the bridge uses it instead of generating a file.

### 4. Connect ChatGPT

ChatGPT Web cannot reach a plain localhost MCP endpoint directly. Use the secure MCP/tunnel connection mechanism currently supported by OpenAI and forward it to:

```text
http://127.0.0.1:3456/mcp
```

Use the bridge token as the MCP bearer credential where the connection flow requires it.

The bridge keeps a localhost-first design: it binds `127.0.0.1`, never exposes a public interface, and never self-hosts a tunnel.

### 5. Refresh tools and verify

After connecting, refresh/rescan the MCP tools in ChatGPT and run a read-only check:

```text
请使用已连接的 DSH App，只做只读检查：
1. 调用 dsh_health
2. 调用 dsh_list_workspaces
3. 不修改任何文件
4. 返回 bridge version、health 和 workspace 名称
```

A healthy first check should look like:

```text
bridge version = 0.6.0
tool count = 23
```

If health is OK, the version matches, and your registered workspace appears, the control path is ready.

## First useful workflow

A practical pattern is:

```text
ChatGPT: define the task and constraints
        ↓
Bridge: create / start a DSH Goal
        ↓
DSH: execute inside its registered workspace
        ↓
Bridge: wait, inspect status, surface approvals
        ↓
ChatGPT: review the result and decide what happens next
```

For a safe first run, start with a read-only Goal:

```text
使用 DSH App 创建一个只读检查目标：
- workspace 使用 dsh_list_workspaces 查到的已注册工作区
- goal：只读检查项目
- constraints：read_only=true
- 列出项目结构并总结 README
- 等待目标结束后只汇报结果，不修改任何文件
```

## Security model

This is a **control bridge**, not a remote shell replacement.

- The MCP server binds to loopback by default.
- It binds `127.0.0.1`, never exposes a public interface, and never self-hosts a tunnel.
- DSH remains responsible for its own sandbox, approvals and workspace rules.
- The bridge only works with workspaces already registered in DSH.
- Tokens and tunnel/runtime secrets are stored outside the repository and should never be committed.
- Write/action tools are real actions. Keep approval policies appropriate for the workspace you expose.
- Tunnel/runtime management is designed to fail closed around process ownership and lifecycle ambiguity.

If you only need inspection, use read-only prompts and keep DSH constraints read-only.

## What this project is not

- It is **not** a ChatGPT API proxy.
- It does **not** make DSH use your ChatGPT subscription as a model provider.
- It does **not** upload an arbitrary workspace to ChatGPT.
- It does **not** bypass DSH approvals or sandboxing.
- It does **not** modify DeepSeek Harness core.

## Troubleshooting

### ChatGPT cannot connect

`127.0.0.1` only exists on your machine. Confirm that your supported secure tunnel/MCP connection forwards to the bridge endpoint and that the bridge token matches the running DSH profile.

### `401 Unauthorized`

Re-read the token from the active DSH home/profile and make sure the connector sends the matching bearer credential.

### No workspace appears

The bridge only lists **registered DSH workspaces**. Register the project in DSH first; the bridge intentionally does not auto-register arbitrary filesystem paths.

### Session exists but is not live in DSH Web

Run the bridge and DSH Web in the same web profile/runtime. Separate runtimes may persist sessions but will not provide the same live UI behavior.

### Tool list looks stale

Restart/upgrade the plugin as needed, then refresh/rescan the MCP tools on the ChatGPT side.

## Project status

This is an actively maintained, independent DSH plugin. Compatibility releases track DeepSeek Harness changes while preserving the bridge's MCP/tool semantics and security boundaries.

Current source version:

```text
dsh-chatgpt-bridge@0.6.0
```

Compatibility: **v0.6.0 → DSH 0.1.7-rc.2**. The exact release commit passed Ubuntu and Windows CI on Node 22 and 24, including a packed-package install and model-free official DSH CLI/Web/MCP integration. Browser UI, real-model work, ChatGPT and tunnel end-to-end remain unverified for this version. The older published v0.5.1 package targets DSH 0.1.1-rc.2.

Distribution and ecosystem listings:

- [npm](https://www.npmjs.com/package/dsh-chatgpt-bridge)
- [M8ven](https://m8ven.ai/mcp/jiezeng2004-design-dsh-chatgpt-bridge-14d0zo)
- [dshbase](https://dshbase.com/plugins/dsh-chatgpt-bridge/)
- [DSHarness](https://dsharness.org/plugin/jiezeng2004-design/dsh-chatgpt-bridge)

Third-party directory labels describe those directories' own checks; they are not security audits or endorsements.

## Development

The bridge is a standalone DSH plugin with no DSH core modifications. Development focuses on:

- MCP tool/schema compatibility;
- Goal/session lifecycle reliability;
- native settings and tunnel runtime management;
- process-ownership safety;
- regression and compatibility testing across supported DSH releases.

Before publishing a new version, run `npm run typecheck`, `npm run build`, `npm test` and `npm run test:release`. The last command installs the actual tarball and exact DSH host in a disposable directory.

## License

MIT. See [LICENSE](LICENSE).

---

**Unofficial community project. Not affiliated with or endorsed by OpenAI or DeepSeek.**

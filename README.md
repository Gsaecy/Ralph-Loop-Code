# Ralph Loop (VS Code Extension) v0.0.5

把一段 AI 开发指令拆分为「可执行的单一命令 + 对应验收标准」，并用 Ralph loop 式的迭代流程执行：不达标就把“错误/偏差”当提示继续下一轮，直到严格命中 completion-promise 或达到最大迭代次数。

## ✨ v0.0.5 新功能

- **多模型支持**：除了 GitHub Copilot，现支持 OpenAI‑兼容接口（如 DeepSeek）
- **插件系统**：可在 `.ralph-loop/plugins/` 下添加自定义工具与验证器
- **工具调用（OpenAI‑兼容模式）**：DeepSeek 等外部模型也能像 Copilot 一样使用工具读/写/搜索
- **更多验收检查**：新增 HTTP 状态码、shell 输出、JSONPath、正则匹配等验证类型
- **历史记录与回放**：每次迭代保存快照，支持查看与回放
- **进度反馈**：状态栏显示进度，可取消的进度通知

## 使用

命令面板中运行：
- `Ralph Loop: 开启循环 (/ralph-loop)`
- `Ralph Loop: 取消循环 (/cancel-ralph)`
- `Ralph Loop: 设置 OpenAI-兼容 API Key`（可用于 DeepSeek / 其它 OpenAI-兼容接口）

启动时可直接粘贴类似 Claude Code 的语法：

```
/ralph-loop "Your task description" --completion-promise "DONE" --max-iterations 50
```

## 普通用户安装（无需 Node/npm）

如果你的目标是让“只装了 VS Code 的用户”也能直接安装扩展，有两种常见分发方式：

### 方式 1：发布到 VS Code Marketplace（推荐，真正一键）

用户侧（无需 Node/npm）：

1. 打开 VS Code → 扩展（Extensions）
2. 搜索：`Ralph Loop`
3. 点击 **Install**

维护者侧（你需要做一次发布配置）：

1. 在 VS Code Marketplace 创建 Publisher
2. 把 [package.json](package.json) 里的 `publisher` 改成你的 Publisher ID（不要用 `local`）
3. 安装/使用 `vsce` 登录并发布（需要 Marketplace PAT）：
	- `npm install`
	- `npx vsce login <your-publisher-id>`
	- `npx vsce publish`

发布完成后，任何人都可以通过 Marketplace 一键安装。

### 方式 2：GitHub Releases 提供 VSIX（无需 Node/npm，推荐）

用户侧（无需 Node/npm）：

1. 打开本仓库的 Releases 页面：
	- https://github.com/Gsaecy/Ralph-Loop-Code/releases
2. 下载最新版本的 `ralph-loop-*.vsix` 文件（例如 `ralph-loop-0.0.5.vsix`）
3. VS Code 命令面板 → `Extensions: Install from VSIX...` → 选择该文件

**当前最新版本**：`v0.0.5`（[下载链接](https://github.com/Gsaecy/Ralph-Loop-Code/releases/latest)）

本仓库已配置 GitHub Actions 自动构建 VSIX（见 [.github/workflows/release-vsix.yml](.github/workflows/release-vsix.yml)）：

- 当你 push tag（例如 `v0.0.5`）时，会自动构建并在 Release 中附带 VSIX。

维护者发布 VSIX（示例）：

```bash
git tag v0.0.2
git push origin v0.0.2
```

## 从 GitHub 源码本地安装/运行（推荐给开源用户）

只要能运行 Node.js + VS Code，就可以直接从你的 Git 仓库本地构建并安装该扩展。

### 前置条件

- Git
- Node.js（建议使用当前 LTS 版本）
- VS Code（建议 1.94+）

### 1) 克隆并进入扩展目录

在命令行中执行（把 URL 换成你的仓库地址）：

```bash
git clone https://github.com/Gsaecy/Ralph-Loop-Code.git
cd Ralph-Loop-Code
```

关键点：后续所有 `npm run ...` 都必须在“包含 package.json 的目录”执行。

### 2) 安装依赖 + 编译

```bash
npm install
npm run compile
```

### 3) 方式 A：用 Extension Host 运行（开发调试）

适合贡献代码/调试逻辑：

1. 用 VS Code 打开该文件夹
2. 按 `F5`（Run Extension），会启动一个新的 **Extension Development Host** 窗口
3. 在新窗口里按 `Ctrl+Shift+P`，运行命令：
	- `Ralph Loop: 开启循环 (/ralph-loop)`
	- `Ralph Loop: 取消循环 (/cancel-ralph)`

### 4) 方式 B：打包成 VSIX 并安装到日常 VS Code

适合“普通用户从源码安装”：

```bash
npm install
npm run package
```

会在当前目录生成一个 `ralph-loop-*.vsix` 文件。

安装方法：

- VS Code 命令面板 → `Extensions: Install from VSIX...` → 选择该 `*.vsix`

或者使用一键脚本（需要命令行可用 `code`）：

```bash
npm run package:install
```

如果系统提示找不到 `code` 命令：
- Windows：确保安装 VS Code 时勾选了 “Add to PATH”，或重开终端
- macOS：VS Code 中运行 `Shell Command: Install 'code' command in PATH`

### 常见问题

#### Q: npm 报错 `Missing script: "package"`

你很可能在错误的目录运行了命令。请先确认当前目录下有 `package.json`，并执行：

```bash
npm run
```

看脚本列表里是否存在 `package`。

## 模型/Provider 选择（新增）

本扩展支持两种 provider：

1) **copilot**（默认）：使用 VS Code Language Model API（通常是 GitHub Copilot），支持自动工具调用（读/写/搜索/跑 Task）。
2) **openaiCompatible**：通过 OpenAI-兼容的 Chat Completions 接口调用模型（例如 DeepSeek）。

配置入口：VS Code Settings → 搜索 `Ralph Loop`：
- `ralphLoop.provider`: `copilot` | `openaiCompatible`
- `ralphLoop.openaiCompatible.baseUrl`: 默认为 `https://api.deepseek.com/v1`
- `ralphLoop.openaiCompatible.model`: 默认为 `deepseek-chat`

API Key 通过命令安全保存（SecretStorage）：
- `Ralph Loop: 设置 OpenAI-兼容 API Key`

### OpenAI‑Compatible 模式下的工具调用

从 v0.0.6 开始，openaiCompatible 模式也支持工具调用（Tool Calling），使用 OpenAI‑Compatible 的 function calling 协议。这意味着：

**支持的功能：**
- ✅ 完整的工具调用循环（与 copilot 模式相同）
- ✅ 支持所有现有工具：`workspace.readFile`、`workspace.writeFile`、`workspace.listFiles`、`workspace.search`、`workspace.getDiagnostics`、`vscode.listTasks`、`vscode.runTask`、`loop.verify`
- ✅ 自动工具调用与结果回灌
- ✅ 最多 30 轮工具调用循环

**使用要求：**
1. 目标 API 必须支持 OpenAI‑Compatible 的 `tools` 参数和 `tool_calls` 响应格式
2. 模型需要支持 function calling 功能（如 DeepSeek‑Chat、GPT‑4‑Turbo 等）
3. API Key 需要正确设置

**工作原理：**
1. 扩展将 `PrivateTool` 接口转换为 OpenAI‑Compatible 的 `tools` 参数格式
2. 模型响应中的 `tool_calls` 会被解析并执行对应工具
3. 工具结果以 `tool` 角色消息回灌给模型
4. 循环继续直到模型输出最终文本或无工具调用

**向后兼容：**
- 如果模型不支持工具调用或返回纯文本，扩展会回退到 `<edits>...</edits>` 模式
- 现有的 `<edits>` 标签解析逻辑仍然有效

**注意事项：**
- 不同 API 提供商对工具调用的支持程度可能不同
- 工具调用会增加 API 调用次数（每次工具调用都需要一次 API 请求）
- 确保 API 提供商支持足够的上下文长度以容纳工具调用历史

## 运行进度反馈（新增）

- 状态栏会显示当前迭代进度与 provider
- 运行时会弹出可取消的进度通知（取消会请求停止循环）

## 执行方式（更接近 Ralph loop）

- 扩展会在工作区创建状态文件：`.claude/ralph-loop.local.md`，记录迭代次数与参数。
- 每次迭代会把“上一次失败/偏差 + 当前诊断信息”回灌给模型，促使其进入 debug。
- 模型默认通过工具调用来完成工作：读取文件、写入文件、搜索内容、获取 VS Code Diagnostics。
- 为了更必收敛：循环结束需要同时满足两点：
	1) 模型回复的“最后一行”严格等于 `--completion-promise`
	2) 扩展侧验收验证器（基于拆分时生成的 `criteriaChecks` + 当前 Diagnostics）全部通过
- `Ralph Loop: 取消循环 (/cancel-ralph)` 会请求取消当前迭代，并删除状态文件。

## VS Code Task 验收（优先）

拆分阶段会尽量生成可机器验证的 `criteriaChecks`，其中你可以让它包含：

```json
{ "type": "vscodeTask", "label": "build", "timeoutMs": 600000 }
```

扩展会在每轮 verifier 中运行该 Task，并要求 `exitCode === 0` 才算通过。

模型也可以在迭代中使用工具：
- `vscode.listTasks`：列出当前工作区可用 Task
- `vscode.runTask`：运行指定 label 的 Task

### completion-promise 严格规则

只有当模型**整段回复的最后一行**（去掉末尾空行后）与 `--completion-promise` 的字符串**完全一致**时，循环才会退出。

## 更必收敛的提示词建议

1) **写成可验证的要求**

尽量把目标写成“能被机器验收”的形式（例如：生成某个文件、文件包含某段文本、错误数为 0、Task 必须通过等）。扩展会在拆分阶段生成 `criteriaChecks` 并用 verifier 强制检查；若缺少可验证标准，verifier 会拒绝放行 completion-promise。

2) **优先提供 VS Code Tasks 作为验收手段**

如果你的项目有 `.vscode/tasks.json`（例如 `build`/`test`），模型会优先使用 `vscode.listTasks`/`vscode.runTask` 运行任务，并要求 `exitCode === 0` 才能通过验收；这比“主观判断完成”更稳定，也更不容易跑偏。

## 开发

```bash
npm install
npm run compile
```

按 `F5` 启动 Extension Host 调试。

## 直接安装到日常 VS Code（VSIX）

在扩展项目根目录执行：

```bash
npm install
npm run package
```

会生成一个 `*.vsix` 文件，然后用 VS Code 安装：

- 命令面板 → `Extensions: Install from VSIX...`

也可以用脚本一键打包+安装（需要命令行可用 `code`）：

```bash
npm run package:install
```

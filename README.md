# Ralph Loop (VS Code Extension)

把一段 AI 开发指令拆分为「可执行的单一命令 + 对应验收标准」，并用 Ralph loop 式的迭代流程执行：不达标就把“错误/偏差”当提示继续下一轮，直到严格命中 completion-promise 或达到最大迭代次数。

## 使用

命令面板中运行：
- `Ralph Loop: 开启循环 (/ralph-loop)`
- `Ralph Loop: 取消循环 (/cancel-ralph)`

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

### 方式 2：GitHub Releases 提供 VSIX（无需 Node/npm，适合不走 Marketplace）

用户侧（无需 Node/npm）：

1. 打开你的 GitHub 仓库 → Releases：
	- https://github.com/Gsaecy/Ralph-Loop-Code/releases
2. 下载发布资产里的 `ralph-loop-*.vsix`
3. VS Code 命令面板 → `Extensions: Install from VSIX...` → 选择该文件

本仓库已提供 GitHub Actions 工作流来自动产出 VSIX（见 [.github/workflows/release-vsix.yml](.github/workflows/release-vsix.yml)）：

- 当你 push tag（例如 `v0.0.2`）时，会自动构建并在 Release 中附带 VSIX。

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

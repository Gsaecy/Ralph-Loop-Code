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

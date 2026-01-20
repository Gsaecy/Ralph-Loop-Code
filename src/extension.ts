import * as vscode from 'vscode';

type RalphLoopConfig = {
	prompt: string;
	completionPromise: string;
	maxIterations: number;
};

type DecomposedTask = {
	id: string;
	instruction: string;
	completionCriteria: string;
	criteriaChecks?: CriterionCheck[];
	order: number;
};

type CriterionCheck =
	| { type: 'diagnostics'; maxErrors: number }
	| { type: 'fileExists'; path: string }
	| { type: 'fileContains'; path: string; text: string }
	| { type: 'globExists'; glob: string; minCount?: number }
	| { type: 'vscodeTask'; label: string; timeoutMs?: number }
	| { type: 'userConfirm'; question: string };

type DecompositionResult = {
	tasks: DecomposedTask[];
	clarifications: Array<{ question: string; why: string }>;
};

type EditFile = {
	path: string; // workspace-relative
	content: string;
};

type ToolResult = {
	ok: boolean;
	data?: unknown;
	error?: string;
};

const OUTPUT_CHANNEL_NAME = 'Ralph Loop';

const STATE_FILE = '.claude/ralph-loop.local.md';

let activeRun:
	| {
		cts: vscode.CancellationTokenSource;
		startedAt: number;
		config: RalphLoopConfig;
	}
	| undefined;

function getWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
	return vscode.workspace.workspaceFolders?.[0];
}

function sanitizeRelativePath(p: string): string | undefined {
	const normalized = p.replace(/\\/g, '/').trim();
	if (!normalized) return undefined;
	if (normalized.startsWith('/') || /^[a-zA-Z]:\//.test(normalized)) return undefined;
	if (normalized.split('/').some((part) => part === '..')) return undefined;
	return normalized;
}

function tokenizeArgs(input: string): string[] {
	// Very small tokenizer supporting quotes: "..." or '...'
	const tokens: string[] = [];
	let current = '';
	let quote: '"' | "'" | undefined;
	for (let i = 0; i < input.length; i++) {
		const ch = input[i];
		if (quote) {
			if (ch === quote) {
				quote = undefined;
				continue;
			}
			if (ch === '\\' && i + 1 < input.length) {
				const next = input[i + 1];
				if (next === quote || next === '\\') {
					current += next;
					i++;
					continue;
				}
			}
			current += ch;
			continue;
		}

		if (ch === '"' || ch === "'") {
			quote = ch;
			continue;
		}
		if (/\s/.test(ch)) {
			if (current) {
				tokens.push(current);
				current = '';
			}
			continue;
		}
		current += ch;
	}
	if (current) tokens.push(current);
	return tokens;
}

function parseRalphLoopCommand(raw: string): RalphLoopConfig | { error: string } {
	const tokens = tokenizeArgs(raw);
	const filtered = tokens[0] === '/ralph-loop' ? tokens.slice(1) : tokens;
	if (filtered.length === 0) return { error: '缺少提示词。示例：/ralph-loop "..." --completion-promise "DONE" --max-iterations 50' };

	const prompt = filtered[0];
	let completionPromise = '';
	let maxIterations = 0;

	for (let i = 1; i < filtered.length; i++) {
		const t = filtered[i];
		if (t === '--completion-promise') {
			completionPromise = filtered[i + 1] ?? '';
			i++;
			continue;
		}
		if (t === '--max-iterations') {
			const v = Number(filtered[i + 1]);
			maxIterations = Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0;
			i++;
			continue;
		}
	}

	if (!completionPromise) {
		return { error: '缺少 --completion-promise（严格字符串匹配的退出条件）。' };
	}
	if (!maxIterations || maxIterations <= 0) {
		return { error: '缺少或非法 --max-iterations（强烈建议设置，避免死循环）。' };
	}

	return { prompt, completionPromise, maxIterations };
}

function lastNonEmptyLine(text: string): string {
	const lines = text.split(/\r?\n/).map((l) => l.trimEnd());
	for (let i = lines.length - 1; i >= 0; i--) {
		if (lines[i].trim().length > 0) return lines[i].trim();
	}
	return '';
}

function extractTagContent(text: string, tag: string): string | undefined {
	const re = new RegExp(`<${tag}>[\\s\\S]*?<\\/${tag}>`, 'i');
	const match = text.match(re);
	if (!match) return undefined;
	const full = match[0];
	const inner = full.replace(new RegExp(`^<${tag}>`, 'i'), '').replace(new RegExp(`<\\/${tag}>$`, 'i'), '');
	return inner.trim();
}

function extractJsonArrayFromEditsBlock(text: string): EditFile[] {
	const raw = extractTagContent(text, 'edits');
	if (!raw) return [];
	try {
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed
			.map((x) => {
				if (!x || typeof x !== 'object') return undefined;
				const path = typeof (x as any).path === 'string' ? (x as any).path : '';
				const content = typeof (x as any).content === 'string' ? (x as any).content : '';
				if (!path) return undefined;
				return { path, content } as EditFile;
			})
			.filter((x): x is EditFile => Boolean(x));
	} catch {
		return [];
	}
}

async function pickChatModel(context: vscode.ExtensionContext): Promise<vscode.LanguageModelChat> {
	// Must be called in response to a user action.
	const access = context.languageModelAccessInformation;
	if (!access.canSendRequest) {
		throw vscode.LanguageModelError.NoPermissions('当前扩展没有使用语言模型的权限（需要用户授权）。');
	}

	const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
	if (models.length === 0) {
		throw new Error('没有可用的语言模型（copilot）。请确认已启用 Copilot / Language Model API。');
	}
	return models[0];
}

async function requestText(
	model: vscode.LanguageModelChat,
	messages: vscode.LanguageModelChatMessage[],
	token: vscode.CancellationToken
): Promise<string> {
	const response = await model.sendRequest(messages, {}, token);
	let text = '';
	for await (const part of response.text) {
		text += part;
	}
	return text;
}

type PrivateTool = {
	name: string;
	description: string;
	inputSchema: object;
	invoke: (input: any, token: vscode.CancellationToken) => Promise<ToolResult>;
};

type VerificationFailure = {
	taskId?: string;
	check?: CriterionCheck;
	reason: string;
};

type VerificationReport = {
	allPassed: boolean;
	errors: number;
	failures: VerificationFailure[];
};

type TaskRunCacheEntry = {
	ranAt: number;
	ok: boolean;
	exitCode?: number;
	error?: string;
};

type LoopRuntime = {
	iteration: number;
	cache: {
		taskRuns: Map<string, TaskRunCacheEntry>;
		verifyReport?: VerificationReport;
	};
};

async function requestWithTools(
	model: vscode.LanguageModelChat,
	baseMessages: vscode.LanguageModelChatMessage[],
	tools: PrivateTool[],
	token: vscode.CancellationToken,
	output?: vscode.OutputChannel
): Promise<string> {
	const toolMap = new Map(tools.map((t) => [t.name, t] as const));
	const toolSpecs: vscode.LanguageModelChatTool[] = tools.map((t) => ({
		name: t.name,
		description: t.description,
		inputSchema: t.inputSchema,
	}));

	const messages: vscode.LanguageModelChatMessage[] = [...baseMessages];
	let finalText = '';
	const maxToolRounds = 30;

	for (let round = 1; round <= maxToolRounds; round++) {
		const response = await model.sendRequest(
			messages,
			{
				justification: '用于将开发指令拆分并在工作区内迭代修改与验证。',
				tools: toolSpecs,
				toolMode: vscode.LanguageModelChatToolMode.Auto,
			},
			token
		);

		const toolCalls: vscode.LanguageModelToolCallPart[] = [];
		let chunkText = '';
		for await (const chunk of response.stream) {
			if (chunk instanceof vscode.LanguageModelTextPart) {
				chunkText += chunk.value;
			} else if (chunk instanceof vscode.LanguageModelToolCallPart) {
				toolCalls.push(chunk);
			}
		}

		finalText += chunkText;

		if (toolCalls.length === 0) {
			return finalText;
		}

		for (const call of toolCalls) {
			const tool = toolMap.get(call.name);
			let result: ToolResult;
			if (!tool) {
				result = { ok: false, error: `Unknown tool: ${call.name}` };
			} else {
				try {
					result = await tool.invoke(call.input, token);
				} catch (e) {
					const msg = e instanceof Error ? e.message : String(e);
					result = { ok: false, error: msg };
				}
			}

			if (output) {
				output.appendLine(`[tool] ${call.name} -> ${result.ok ? 'ok' : 'fail'}`);
			}

			// Feed tool-call + result back to model
			messages.push(vscode.LanguageModelChatMessage.Assistant([call]));
			messages.push(
				vscode.LanguageModelChatMessage.User([
					new vscode.LanguageModelToolResultPart(
						call.callId,
						[new vscode.LanguageModelTextPart(JSON.stringify(result))]
					),
				])
			);
		}
	}

	return finalText;
}

function safeJsonParseObject<T>(text: string): T {
	// Expect JSON only, but tolerate accidental wrapping.
	const trimmed = text.trim();
	try {
		return JSON.parse(trimmed) as T;
	} catch {
		// Try to extract first {...}
		const firstBrace = trimmed.indexOf('{');
		const lastBrace = trimmed.lastIndexOf('}');
		if (firstBrace >= 0 && lastBrace > firstBrace) {
			const slice = trimmed.slice(firstBrace, lastBrace + 1);
			return JSON.parse(slice) as T;
		}
		throw new Error('模型返回的 JSON 无法解析。');
	}
}

async function writeWorkspaceFile(relativePath: string, content: string): Promise<void> {
	const folder = getWorkspaceFolder();
	if (!folder) throw new Error('当前没有打开工作区文件夹。');
	const safe = sanitizeRelativePath(relativePath);
	if (!safe) throw new Error(`不安全的路径：${relativePath}`);

	const uri = vscode.Uri.joinPath(folder.uri, safe);
	// ensure parent directory
	const parts = safe.split('/').filter(Boolean);
	const parent = parts.length > 1 ? vscode.Uri.joinPath(folder.uri, ...parts.slice(0, -1)) : folder.uri;
	await vscode.workspace.fs.createDirectory(parent);
	await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
}

async function openWorkspaceFile(relativePath: string): Promise<void> {
	const folder = getWorkspaceFolder();
	if (!folder) return;
	const safe = sanitizeRelativePath(relativePath);
	if (!safe) return;
	const uri = vscode.Uri.joinPath(folder.uri, safe);
	const doc = await vscode.workspace.openTextDocument(uri);
	await vscode.window.showTextDocument(doc, { preview: false });
}

async function decomposePrompt(
	context: vscode.ExtensionContext,
	model: vscode.LanguageModelChat,
	prompt: string,
	token: vscode.CancellationToken
): Promise<DecompositionResult> {
	const messages: vscode.LanguageModelChatMessage[] = [
		vscode.LanguageModelChatMessage.User(
			[
				'[system]',
				'你是一个“开发指令拆分器”。',
				'把用户指令拆成多个“单一具体命令 + 对应可验证的验收标准”。',
				'如果指令不明确或验收标准不明确，必须输出 clarifications 列表。',
				'验收标准必须尽量给出可机器验证的 criteriaChecks（否则容易不收敛）。',
				'只输出 JSON，不要额外文本。',
				'JSON Schema:',
				'{',
				'  "tasks": [ { "id": "T1", "instruction": "...", "completionCriteria": "...", "criteriaChecks": [ ... ], "order": 1 } ],',
				'  "clarifications": [ { "question": "...", "why": "..." } ]',
				'}',
				'',
				'criteriaChecks 支持类型：',
				'- {"type":"diagnostics","maxErrors":0}',
				'- {"type":"fileExists","path":"src/app.ts"}',
				'- {"type":"fileContains","path":"src/app.ts","text":"export function foo"}',
				'- {"type":"globExists","glob":"src/**/*.ts","minCount":1}',
				'- {"type":"vscodeTask","label":"build","timeoutMs":600000}',
				'- {"type":"userConfirm","question":"请确认 UI 是否正常显示"}',
			].join('\n')
		),
		vscode.LanguageModelChatMessage.User(prompt),
	];

	const text = await requestText(model, messages, token);
	const result = safeJsonParseObject<DecompositionResult>(text);
	result.tasks = Array.isArray(result.tasks) ? result.tasks : [];
	result.clarifications = Array.isArray(result.clarifications) ? result.clarifications : [];
	return result;
}

function sortTasks(tasks: DecomposedTask[]): DecomposedTask[] {
	return [...tasks].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

async function verifyCriteria(
	check: CriterionCheck,
	token: vscode.CancellationToken,
	runtime?: LoopRuntime
): Promise<VerificationFailure | undefined> {
	const folder = getWorkspaceFolder();
	if (!folder) return { reason: '未打开工作区文件夹' };

	if (check.type === 'diagnostics') {
		const all = vscode.languages.getDiagnostics();
		const errorCount = all.reduce(
			(acc, [, list]) => acc + list.filter((d) => d.severity === vscode.DiagnosticSeverity.Error).length,
			0
		);
		if (errorCount > check.maxErrors) {
			return { check, reason: `诊断错误数 ${errorCount} > ${check.maxErrors}` };
		}
		return undefined;
	}

	if (check.type === 'fileExists') {
		const safe = sanitizeRelativePath(check.path);
		if (!safe) return { check, reason: '路径不安全/非法' };
		try {
			await vscode.workspace.fs.stat(vscode.Uri.joinPath(folder.uri, safe));
			return undefined;
		} catch {
			return { check, reason: '文件不存在' };
		}
	}

	if (check.type === 'fileContains') {
		const safe = sanitizeRelativePath(check.path);
		if (!safe) return { check, reason: '路径不安全/非法' };
		try {
			const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(folder.uri, safe));
			const text = Buffer.from(bytes).toString('utf8');
			if (!text.includes(check.text)) {
				return { check, reason: '未找到指定文本片段' };
			}
			return undefined;
		} catch (e) {
			return { check, reason: e instanceof Error ? e.message : String(e) };
		}
	}

	if (check.type === 'globExists') {
		const glob = (check.glob || '**/*').trim();
		const minCount = Number.isFinite(check.minCount) ? Math.max(0, Math.floor(check.minCount!)) : 1;
		try {
			const uris = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, glob), '**/node_modules/**', 500);
			if (uris.length < minCount) {
				return { check, reason: `匹配文件数 ${uris.length} < ${minCount}` };
			}
			return undefined;
		} catch (e) {
			return { check, reason: e instanceof Error ? e.message : String(e) };
		}
	}

	if (check.type === 'userConfirm') {
		if (token.isCancellationRequested) return { check, reason: '已取消' };
		const picked = await vscode.window.showInformationMessage(check.question, { modal: true }, '通过', '不通过');
		if (picked !== '通过') {
			return { check, reason: '用户确认未通过' };
		}
		return undefined;
	}

	if (check.type === 'vscodeTask') {
		const label = (check.label || '').trim();
		if (!label) return { check, reason: 'Task label 为空' };
		const timeoutMs = Number.isFinite(check.timeoutMs) ? Math.max(1_000, Math.floor(check.timeoutMs!)) : 5 * 60_000;
		try {
			const run = runtime
				? await runVsCodeTaskCached(runtime, label, timeoutMs, token)
				: { ranAt: Date.now(), ...(await runVsCodeTaskByLabel(label, timeoutMs, token)) };
			if (!run.ok) return { check, reason: run.error ?? 'Task 执行失败' };
			if (run.exitCode !== 0) return { check, reason: `Task "${label}" 退出码 ${String(run.exitCode)}` };
			await new Promise((r) => setTimeout(r, 300));
			return undefined;
		} catch (e) {
			return { check, reason: e instanceof Error ? e.message : String(e) };
		}
	}

	return { check, reason: '未知 check 类型' };
}

async function listVsCodeTasks(): Promise<
	Array<{ label: string; source: string; detail?: string; definitionType?: string }>
> {
	const tasks = await vscode.tasks.fetchTasks();
	return tasks.map((t) => ({
		label: t.name,
		source: typeof t.source === 'string' ? t.source : String(t.source),
		detail: t.detail,
		definitionType: (t.definition as any)?.type ? String((t.definition as any).type) : undefined,
	}));
}

async function runVsCodeTaskByLabel(
	label: string,
	timeoutMs: number,
	token: vscode.CancellationToken
): Promise<{ ok: boolean; exitCode?: number; error?: string }> {
	const tasks = await vscode.tasks.fetchTasks();
	const task = tasks.find((t) => t.name === label);
	if (!task) {
		const available = tasks.map((t) => t.name).slice(0, 50);
		return { ok: false, error: `找不到 Task: ${label}. 可用任务(最多50)：${available.join(', ')}` };
	}

	let resolved = false;
	return await new Promise((resolve) => {
		const timer = setTimeout(() => {
			if (resolved) return;
			resolved = true;
			subEnd.dispose();
			subProcess.dispose();
			resolve({ ok: false, error: `Task 超时（${timeoutMs}ms）：${label}` });
		}, timeoutMs);

		const cancelSub = token.onCancellationRequested(() => {
			if (resolved) return;
			resolved = true;
			clearTimeout(timer);
			subEnd.dispose();
			subProcess.dispose();
			cancelSub.dispose();
			resolve({ ok: false, error: `Task 被取消：${label}` });
		});

		let startedExecution: vscode.TaskExecution | undefined;
		vscode.tasks.executeTask(task).then(
			(exec) => {
				startedExecution = exec;
			},
			(err) => {
				if (resolved) return;
				resolved = true;
				clearTimeout(timer);
				subEnd.dispose();
				subProcess.dispose();
				cancelSub.dispose();
				resolve({ ok: false, error: err instanceof Error ? err.message : String(err) });
			}
		);

		const subEnd = vscode.tasks.onDidEndTask((e) => {
			if (resolved) return;
			// best-effort match: if we have execution, match by reference
			if (startedExecution && e.execution !== startedExecution) return;
			// Sometimes execution reference is different; fallback to label match
			if (!startedExecution && e.execution.task.name !== label) return;
			// Wait for process event to get exit code when available
		});

		const subProcess = vscode.tasks.onDidEndTaskProcess((e) => {
			if (resolved) return;
			if (startedExecution && e.execution !== startedExecution) return;
			if (!startedExecution && e.execution.task.name !== label) return;
			resolved = true;
			clearTimeout(timer);
			subEnd.dispose();
			subProcess.dispose();
			cancelSub.dispose();
			resolve({ ok: true, exitCode: e.exitCode ?? -1 });
		});
	});
}

async function runVsCodeTaskCached(
	runtime: LoopRuntime,
	label: string,
	timeoutMs: number,
	token: vscode.CancellationToken,
	force = false
): Promise<TaskRunCacheEntry> {
	const key = `${label}::${timeoutMs}`;
	if (!force) {
		const cached = runtime.cache.taskRuns.get(key);
		if (cached) return cached;
	}

	const res = await runVsCodeTaskByLabel(label, timeoutMs, token);
	const entry: TaskRunCacheEntry = {
		ranAt: Date.now(),
		ok: res.ok,
		exitCode: res.exitCode,
		error: res.error,
	};
	runtime.cache.taskRuns.set(key, entry);
	return entry;
}

async function verifyTasks(tasks: DecomposedTask[], token: vscode.CancellationToken, runtime?: LoopRuntime): Promise<VerificationReport> {
	const failures: VerificationFailure[] = [];
	let errorCount = 0;

	for (const t of tasks) {
		const checks = t.criteriaChecks ?? [];
		if (checks.length === 0) {
			failures.push({ taskId: t.id, reason: '缺少 criteriaChecks（无法机器验证，需补充或改写验收标准）' });
			continue;
		}
		for (const c of checks) {
			const f = await verifyCriteria(c, token, runtime);
			if (f) {
				failures.push({ taskId: t.id, check: c, reason: f.reason });
			}
		}
	}

	await new Promise((r) => setTimeout(r, 200));

	// Always include diagnostics error count to drive convergence
	const diags = vscode.languages.getDiagnostics();
	errorCount = diags.reduce(
		(acc, [, list]) => acc + list.filter((d) => d.severity === vscode.DiagnosticSeverity.Error).length,
		0
	);
	if (errorCount > 0) {
		failures.push({ reason: `仍存在 VS Code 诊断错误：${errorCount} 个` });
	}

	return { allPassed: failures.length === 0, errors: errorCount, failures };
}

async function writeStateFile(config: RalphLoopConfig, iteration: number): Promise<void> {
	const content = [
		'# ralph-loop.local',
		'',
		`startedAt: ${new Date().toISOString()}`,
		`iteration: ${iteration}`,
		`maxIterations: ${config.maxIterations}`,
		`completionPromise: ${JSON.stringify(config.completionPromise)}`,
		'',
		'prompt:',
		'```',
		config.prompt,
		'```',
		'',
	].join('\n');
	await writeWorkspaceFile(STATE_FILE, content);
}

async function deleteStateFile(): Promise<void> {
	const folder = getWorkspaceFolder();
	if (!folder) return;
	const uri = vscode.Uri.joinPath(folder.uri, STATE_FILE);
	try {
		await vscode.workspace.fs.delete(uri, { recursive: false, useTrash: true });
	} catch {
		// ignore
	}
}

function createPrivateTools(
	tasksProvider: () => DecomposedTask[],
	runtimeProvider: () => LoopRuntime,
	output?: vscode.OutputChannel
): PrivateTool[] {
	const folder = getWorkspaceFolder();
	const ensureFolder = () => {
		if (!folder) throw new Error('当前没有打开工作区文件夹。');
		return folder;
	};

	return [
		{
			name: 'vscode.listTasks',
			description: '列出当前工作区可运行的 VS Code Tasks（用于选择验收验证）。输入: {}',
			inputSchema: { type: 'object', properties: {} },
			invoke: async (_input: any) => {
				try {
					const list = await listVsCodeTasks();
					return { ok: true, data: { tasks: list } };
				} catch (e) {
					return { ok: false, error: e instanceof Error ? e.message : String(e) };
				}
			},
		},
		{
			name: 'vscode.runTask',
			description: '运行指定 VS Code Task 并返回 exitCode（同一轮会缓存）。输入: {label, timeoutMs?, force?}',
			inputSchema: {
				type: 'object',
				properties: {
					label: { type: 'string' },
					timeoutMs: { type: 'number' },
					force: { type: 'boolean' },
				},
				required: ['label'],
			},
			invoke: async (input: any, token: vscode.CancellationToken) => {
				try {
					const label = String(input.label ?? '').trim();
					const timeoutMs = Number.isFinite(input.timeoutMs) ? Math.max(1_000, Math.floor(input.timeoutMs)) : 5 * 60_000;
					const force = Boolean(input.force);
					const runtime = runtimeProvider();
					const run = await runVsCodeTaskCached(runtime, label, timeoutMs, token, force);
					return {
						ok: run.ok,
						data: run.ok ? { label, exitCode: run.exitCode, cachedAtIteration: runtime.iteration } : undefined,
						error: run.ok ? undefined : run.error,
					};
				} catch (e) {
					return { ok: false, error: e instanceof Error ? e.message : String(e) };
				}
			},
		},
		{
			name: 'loop.verify',
			description: '运行扩展侧验收验证器（同一轮会缓存），返回是否所有 criteriaChecks 都通过。输入: {force?}',
			inputSchema: { type: 'object', properties: { force: { type: 'boolean' } } },
			invoke: async (input: any, token: vscode.CancellationToken) => {
				try {
					const runtime = runtimeProvider();
					const force = Boolean(input?.force);
					if (!force && runtime.cache.verifyReport) {
						return { ok: true, data: { ...runtime.cache.verifyReport, cachedAtIteration: runtime.iteration } };
					}
					const tasks = tasksProvider();
					const report = await verifyTasks(tasks, token, runtime);
					runtime.cache.verifyReport = report;
					return { ok: true, data: { ...report, cachedAtIteration: runtime.iteration } };
				} catch (e) {
					return { ok: false, error: e instanceof Error ? e.message : String(e) };
				}
			},
		},
		{
			name: 'workspace.readFile',
			description: '读取工作区内文件内容。输入: {path, startLine?, endLine?, maxChars?}',
			inputSchema: {
				type: 'object',
				properties: {
					path: { type: 'string' },
					startLine: { type: 'number' },
					endLine: { type: 'number' },
					maxChars: { type: 'number' },
				},
				required: ['path'],
			},
			invoke: async (input: any) => {
				try {
					const ws = ensureFolder();
					const safe = sanitizeRelativePath(String(input.path ?? ''));
					if (!safe) return { ok: false, error: 'invalid path' };
					const uri = vscode.Uri.joinPath(ws.uri, safe);
					const bytes = await vscode.workspace.fs.readFile(uri);
					let text = Buffer.from(bytes).toString('utf8');
					const startLine = Number.isFinite(input.startLine) ? Math.max(1, Math.floor(input.startLine)) : 1;
					const endLine = Number.isFinite(input.endLine) ? Math.max(startLine, Math.floor(input.endLine)) : undefined;
					if (startLine !== 1 || endLine !== undefined) {
						const lines = text.split(/\r?\n/);
						const slice = lines.slice(startLine - 1, endLine);
						text = slice.join('\n');
					}
					const maxChars = Number.isFinite(input.maxChars) ? Math.max(200, Math.floor(input.maxChars)) : 20000;
					if (text.length > maxChars) {
						text = text.slice(0, maxChars) + '\n\n...<truncated>...';
					}
					return { ok: true, data: { path: safe, content: text } };
				} catch (e) {
					return { ok: false, error: e instanceof Error ? e.message : String(e) };
				}
			},
		},
		{
			name: 'workspace.writeFile',
			description: '写入工作区内文件（覆盖写入）。输入: {path, content}',
			inputSchema: {
				type: 'object',
				properties: {
					path: { type: 'string' },
					content: { type: 'string' },
				},
				required: ['path', 'content'],
			},
			invoke: async (input: any) => {
				try {
					const safe = sanitizeRelativePath(String(input.path ?? ''));
					if (!safe) return { ok: false, error: 'invalid path' };
					await writeWorkspaceFile(safe, String(input.content ?? ''));
					return { ok: true, data: { path: safe, bytes: String(input.content ?? '').length } };
				} catch (e) {
					return { ok: false, error: e instanceof Error ? e.message : String(e) };
				}
			},
		},
		{
			name: 'workspace.listFiles',
			description: '按 glob 列出工作区文件。输入: {glob, maxResults?}',
			inputSchema: {
				type: 'object',
				properties: {
					glob: { type: 'string' },
					maxResults: { type: 'number' },
				},
				required: ['glob'],
			},
			invoke: async (input: any) => {
				try {
					const ws = ensureFolder();
					const glob = String(input.glob ?? '**/*');
					const maxResults = Number.isFinite(input.maxResults) ? Math.min(200, Math.max(1, Math.floor(input.maxResults))) : 50;
					const uris = await vscode.workspace.findFiles(new vscode.RelativePattern(ws, glob), '**/node_modules/**', maxResults);
					const paths = uris.map((u) => vscode.workspace.asRelativePath(u, false));
					return { ok: true, data: { glob, files: paths } };
				} catch (e) {
					return { ok: false, error: e instanceof Error ? e.message : String(e) };
				}
			},
		},
		{
			name: 'workspace.search',
			description: '在工作区中搜索文本。输入: {query, isRegex?, maxResults?, includePattern?}',
			inputSchema: {
				type: 'object',
				properties: {
					query: { type: 'string' },
					isRegex: { type: 'boolean' },
					maxResults: { type: 'number' },
					includePattern: { type: 'string' },
				},
				required: ['query'],
			},
			invoke: async (input: any) => {
				try {
					const ws = ensureFolder();
					const query = String(input.query ?? '').trim();
					if (!query) return { ok: false, error: 'empty query' };
					const isRegex = Boolean(input.isRegex);
					const maxResults = Number.isFinite(input.maxResults)
						? Math.min(200, Math.max(1, Math.floor(input.maxResults)))
						: 50;
					const includePattern = typeof input.includePattern === 'string' && input.includePattern.trim()
						? input.includePattern.trim()
						: '**/*';

					const results: Array<{ path: string; line: number; text: string }> = [];
					const re = isRegex ? new RegExp(query, 'g') : undefined;
					const uris = await vscode.workspace.findFiles(
						new vscode.RelativePattern(ws, includePattern),
						'**/node_modules/**',
						2000
					);

					// Safety limits: scan only first N files and first M chars per file
					const maxFilesToScan = 200;
					const maxCharsPerFile = 200_000;
					const files = uris.slice(0, maxFilesToScan);

					for (const uri of files) {
						if (results.length >= maxResults) break;
						let text = '';
						try {
							const bytes = await vscode.workspace.fs.readFile(uri);
							text = Buffer.from(bytes).toString('utf8');
						} catch {
							continue;
						}
						if (text.length > maxCharsPerFile) {
							text = text.slice(0, maxCharsPerFile);
						}
						const lines = text.split(/\r?\n/);
						for (let i = 0; i < lines.length; i++) {
							if (results.length >= maxResults) break;
							const lineText = lines[i];
							const matched = re ? re.test(lineText) : lineText.includes(query);
							if (matched) {
								results.push({
									path: vscode.workspace.asRelativePath(uri, false),
									line: i + 1,
									text: lineText.slice(0, 300),
								});
							}
							if (re) re.lastIndex = 0;
						}
					}

					return {
						ok: true,
						data: {
							query,
							isRegex,
							includePattern,
							scannedFiles: files.length,
							results,
						},
					};
				} catch (e) {
					return { ok: false, error: e instanceof Error ? e.message : String(e) };
				}
			},
		},
		{
			name: 'workspace.getDiagnostics',
			description: '获取 VS Code 诊断信息（错误/警告）。输入: {path?}',
			inputSchema: {
				type: 'object',
				properties: {
					path: { type: 'string' },
				},
			},
			invoke: async (input: any) => {
				try {
					const ws = ensureFolder();
					let uris: vscode.Uri[] = [];
					if (typeof input.path === 'string' && input.path.trim()) {
						const safe = sanitizeRelativePath(input.path);
						if (!safe) return { ok: false, error: 'invalid path' };
						uris = [vscode.Uri.joinPath(ws.uri, safe)];
					} else {
						uris = vscode.languages.getDiagnostics().map(([u]) => u);
					}
					const items: Array<{ path: string; severity: string; message: string; range: string; source?: string; code?: string | number }> = [];
					for (const uri of uris) {
						for (const d of vscode.languages.getDiagnostics(uri)) {
							items.push({
								path: vscode.workspace.asRelativePath(uri, false),
								severity: vscode.DiagnosticSeverity[d.severity],
								message: d.message,
								range: `${d.range.start.line + 1}:${d.range.start.character + 1}-${d.range.end.line + 1}:${d.range.end.character + 1}`,
								source: d.source,
								code: typeof d.code === 'object' ? (d.code as any).value : d.code,
							});
						}
					}
					return { ok: true, data: { count: items.length, items: items.slice(0, 200) } };
				} catch (e) {
					return { ok: false, error: e instanceof Error ? e.message : String(e) };
				}
			},
		},
	];
}

async function runRalphLoop(
	context: vscode.ExtensionContext,
	output: vscode.OutputChannel,
	config: RalphLoopConfig
): Promise<void> {
	const folder = getWorkspaceFolder();
	if (!folder) {
		vscode.window.showErrorMessage('请先打开一个工作区文件夹。');
		return;
	}

	if (activeRun) {
		vscode.window.showWarningMessage('已有 Ralph Loop 正在运行。请先取消或等待完成。');
		return;
	}

	const cts = new vscode.CancellationTokenSource();
	activeRun = { cts, startedAt: Date.now(), config };
	output.show(true);
	output.appendLine(`[start] maxIterations=${config.maxIterations}, completionPromise="${config.completionPromise}"`);
	output.appendLine('[info] 注意：第一次迭代往往不正确；未达标会自动继续。');

	try {
		await writeStateFile(config, 1);
		const model = await pickChatModel(context);
		const decomposition = await decomposePrompt(context, model, config.prompt, cts.token);
		const tasks = sortTasks(decomposition.tasks);

		if (decomposition.clarifications.length > 0 || tasks.length === 0) {
			const md = [
				'# Ralph Loop - 需要你补充的信息',
				'',
				'原始指令：',
				'',
				'```',
				config.prompt,
				'```',
				'',
				'## Clarifications',
				...decomposition.clarifications.map((c, i) => `${i + 1}. ${c.question}\n   - why: ${c.why}`),
				'',
				'补充完成后，再次运行命令。',
			].join('\n');

			await writeWorkspaceFile('ralph-loop.clarifications.md', md);
			await openWorkspaceFile('ralph-loop.clarifications.md');
			vscode.window.showWarningMessage('指令/验收标准不够明确：已生成 ralph-loop.clarifications.md，请补充后重试。');
			return;
		}

		const planMd = [
			'# Ralph Loop - 执行计划',
			'',
			'## 原始指令',
			'```',
			config.prompt,
			'```',
			'',
			'## completion-promise（严格字符串匹配）',
			'```',
			config.completionPromise,
			'```',
			'',
			'## 任务拆分（按 order 执行）',
			...tasks.map((t) => `- [${t.id}] (order=${t.order})\n  - instruction: ${t.instruction}\n  - criteria: ${t.completionCriteria}`),
			'',
		].join('\n');
		await writeWorkspaceFile('ralph-loop.plan.md', planMd);

		let lastFailure = '';
		const loopRuntime: LoopRuntime = { iteration: 0, cache: { taskRuns: new Map() } };
		const privateTools = createPrivateTools(() => tasks, () => loopRuntime, output);

		for (let iteration = 1; iteration <= config.maxIterations; iteration++) {
			if (cts.token.isCancellationRequested) {
				output.appendLine('[cancelled]');
				vscode.window.showInformationMessage('Ralph Loop 已取消。');
				await deleteStateFile();
				return;
			}

			loopRuntime.iteration = iteration;
			loopRuntime.cache = { taskRuns: new Map() };

			await writeStateFile(config, iteration);

			output.appendLine(`\n[iteration ${iteration}/${config.maxIterations}]`);
			const diag = vscode.languages.getDiagnostics();
			let diagSummary = `diagnostics: ${diag.reduce((acc, [, list]) => acc + list.length, 0)}`;
			try {
				const res = await privateTools
					.find((t) => t.name === 'workspace.getDiagnostics')!
					.invoke({}, cts.token);
				diagSummary = JSON.stringify(res);
			} catch {
				// ignore
			}

			const execPrompt = [
				'你将对当前 VS Code 工作区进行修改来完成任务。',
				'你会在每次迭代收到相同的原始指令，但会带上上一次失败信息。',
				'必须严格按“任务拆分 + 验收标准”推进，并用工具来读/写/搜索/诊断。',
				'重要：只有当扩展侧验证器通过（loop.verify 返回 allPassed=true）时，你才可以输出 completion-promise。',
				'否则一旦你提前输出 completion-promise，会被判定为失败并进入下一轮。',
				'',
				'如果需要修改文件，调用工具 workspace.writeFile（覆盖写入）。',
				'如果需要阅读/定位，调用 workspace.readFile / workspace.search / workspace.listFiles。',
				'如果需要验证，优先使用 vscode.listTasks / vscode.runTask 运行工作区 Task（例如 build/test）。',
				'也可以调用 workspace.getDiagnostics 获取错误/警告。',
				`最后一行严格规则：只有当你确信所有验收标准都满足时，才输出：${config.completionPromise}`,
				'否则最后一行输出任意其它内容（不要等于 completion-promise）。',
				'',
				'--- 原始指令 ---',
				config.prompt,
				'',
				'--- 任务拆分（必须按顺序完成）---',
				...tasks.map((t) => `(${t.order}) ${t.id}\n- instruction: ${t.instruction}\n- criteria: ${t.completionCriteria}`),
				'',
				'--- 当前诊断（供 debug）---',
				diagSummary,
				'',
				'--- 上一次失败/偏差信息（用于 debug）---',
				lastFailure || '(none)',
			].join('\n');

			let text = '';
			try {
				text = await requestWithTools(
					model,
					[
						vscode.LanguageModelChatMessage.User(`[system] 这是第 ${iteration} 次迭代。`),
						vscode.LanguageModelChatMessage.User(execPrompt),
					],
					privateTools,
					cts.token,
					output
				);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				lastFailure = `模型请求失败：${msg}`;
				output.appendLine(`[error] ${lastFailure}`);
				continue;
			}

			// Backward compatibility: if model still emits <edits>, apply them.
			const edits = extractJsonArrayFromEditsBlock(text);
			if (edits.length > 0) {
				output.appendLine('[compat] 检测到 <edits>，按旧格式写入文件');
				try {
					for (const e of edits) {
						const safe = sanitizeRelativePath(e.path);
						if (!safe) {
							throw new Error(`拒绝写入不安全路径：${e.path}`);
						}
						await writeWorkspaceFile(safe, e.content);
						output.appendLine(`[write] ${safe} (${e.content.length} chars)`);
					}
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					lastFailure = `写文件失败：${msg}`;
					output.appendLine(`[error] ${lastFailure}`);
					continue;
				}
			}

			const lastLine = lastNonEmptyLine(text);
			output.appendLine(`[last-line] ${lastLine}`);

			// Always verify using extension-side verifier for convergence.
			const report = await verifyTasks(tasks, cts.token, loopRuntime);
			loopRuntime.cache.verifyReport = report;
			if (report.allPassed && lastLine === config.completionPromise) {
				output.appendLine('[done] completion-promise matched AND verifier passed');
				vscode.window.showInformationMessage('Ralph Loop：验收通过且命中 completion-promise，循环结束。');
				await deleteStateFile();
				return;
			}

			if (report.allPassed && lastLine !== config.completionPromise) {
				lastFailure = [
					'扩展侧验收已通过，但你没有在最后一行输出 completion-promise。',
					`请在确保无额外空行的情况下，让“最后一行”严格等于：${config.completionPromise}`,
				].join('\n');
				continue;
			}

			if (!report.allPassed && lastLine === config.completionPromise) {
				lastFailure = [
					'你提前输出了 completion-promise，但扩展侧验收未通过（严格规则：不允许提前通关）。',
					'失败详情（请逐条修复/补齐）：',
					JSON.stringify(report, null, 2),
				].join('\n');
				continue;
			}

			// Treat mismatch or verifier failure as a debug signal.
			lastFailure = [
				'未通过验收（进入下一轮 debug）。',
				`completion-promise matched: ${String(lastLine === config.completionPromise)}`,
				'扩展侧验证器报告：',
				JSON.stringify(report, null, 2),
			].join('\n');
		}

		output.appendLine('[stop] 达到最大循环次数，仍未命中 completion-promise');
		vscode.window.showWarningMessage('Ralph Loop：达到最大循环次数，仍未完成。请检查计划或提高验收标准可验证性。');
	} finally {
		await deleteStateFile();
		activeRun?.cts.dispose();
		activeRun = undefined;
	}
}

export function activate(context: vscode.ExtensionContext) {
	const output = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
	context.subscriptions.push(output);

	context.subscriptions.push(
		vscode.commands.registerCommand('ralphLoop.start', async () => {
			const raw = await vscode.window.showInputBox({
				prompt: '输入 /ralph-loop 指令（或仅输入提示词 + flags）',
				placeHolder: '/ralph-loop "Your task description" --completion-promise "DONE" --max-iterations 50',
			});
			if (!raw) return;

			const parsed = parseRalphLoopCommand(raw);
			if ('error' in parsed) {
				vscode.window.showErrorMessage(parsed.error);
				return;
			}

			await runRalphLoop(context, output, parsed);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('ralphLoop.cancel', async () => {
			if (!activeRun) {
				vscode.window.showInformationMessage('当前没有正在运行的 Ralph Loop。');
				await deleteStateFile();
				return;
			}
			activeRun.cts.cancel();
			await deleteStateFile();
			vscode.window.showInformationMessage('已请求取消 Ralph Loop（等待当前迭代结束）。');
		})
	);
}

export function deactivate() {
	activeRun?.cts.cancel();
	activeRun?.cts.dispose();
	activeRun = undefined;
}

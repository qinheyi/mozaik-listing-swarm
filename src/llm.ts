/**
 * Model wiring. Three modes:
 *  - live (OpenAI-compatible): any /chat/completions provider via LLM_BASE_URL + LLM_API_KEY + LLM_MODEL
 *    (MiniMax preset via MINIMAX_API_KEY, DeepSeek/OpenRouter/Ollama/... via the generic vars)
 *  - live (Mozaik built-in): OPENAI_API_KEY / ANTHROPIC_API_KEY / GEMINI_API_KEY with a model Mozaik ships (e.g. gpt-5.4-mini)
 *  - mock: deterministic scripted inference runner, no key needed (MOZAIK_MODE=mock or --mock)
 */
import {
	ModelMessageItem,
	OpenAIChatCompletions,
	supportedModels,
	type InferenceInput,
	type InferenceOutput,
	type InferenceRunner,
	type InferenceRunnerConfig,
	type SemanticEvent,
} from "@mozaik-ai/core"
import { MockInferenceRunner } from "./mock"

/** Not exported by @mozaik-ai/core 4.2, derived from the public InferenceRunnerConfig type. */
type GenerativeModel = NonNullable<InferenceRunnerConfig["supportedModels"]>[number]

export type LlmSetup = { mode: "live" | "mock"; model: string; label: string; config: InferenceRunnerConfig }

const ALL_ITEM_TYPES = ["user_message", "system_message", "developer_message", "reasoning", "function_call", "function_call_output", "model_message"]

function openAICompatibleModel(name: string, baseURL: string, apiKey: string): GenerativeModel {
	return {
		endpoint: new OpenAIChatCompletions(undefined, { baseURL, apiKey }),
		specification: {
			name,
			provider: "openai-compatible",
			supportsReasoningEffort: false,
			supportedReasoningEfforts: [],
			supportsStreaming: true,
			contextWindowSize: 128000,
			supportedContextItemTypes: ALL_ITEM_TYPES,
			maxOutputTokens: 8192,
			supportsFunctionCalling: true,
			supportsStructuredOutput: false,
		},
	}
}

export function setupLlm(forceMock: boolean): LlmSetup {
	const env = process.env
	const mock = (): LlmSetup => ({
		mode: "mock",
		model: "mock-model",
		label: "MOCK (scripted inference runner, no API key)",
		config: { runner: new SafeRunner(new MockInferenceRunner()) },
	})
	if (forceMock || env.MOZAIK_MODE === "mock") return mock()

	const parallel = Number(env.MAX_PARALLEL_INFERENCES ?? 12)
	const wrap = (models: GenerativeModel[]) =>
		new SafeRunner(new ModelRouter(models), parallel)

	if (env.LLM_API_KEY && env.LLM_BASE_URL && env.LLM_MODEL) {
		const m = openAICompatibleModel(env.LLM_MODEL, env.LLM_BASE_URL, env.LLM_API_KEY)
		return { mode: "live", model: env.LLM_MODEL, label: `LIVE ${env.LLM_MODEL} @ ${env.LLM_BASE_URL}`, config: { runner: wrap([m]) } }
	}
	if (env.MINIMAX_API_KEY) {
		const name = env.LLM_MODEL ?? "MiniMax-M2.7"
		const base = env.MINIMAX_BASE_URL ?? "https://api.minimaxi.com/v1"
		const m = openAICompatibleModel(name, base, env.MINIMAX_API_KEY)
		return { mode: "live", model: name, label: `LIVE ${name} @ ${base}`, config: { runner: wrap([m]) } }
	}
	if (env.OPENAI_API_KEY || env.ANTHROPIC_API_KEY || env.GEMINI_API_KEY) {
		const name = env.LLM_MODEL ?? (env.OPENAI_API_KEY ? "gpt-5.4-mini" : env.ANTHROPIC_API_KEY ? "claude-haiku-4-5" : "gemini-3.5-flash")
		return { mode: "live", model: name, label: `LIVE ${name} (Mozaik built-in provider)`, config: { runner: wrap(supportedModels) } }
	}
	console.warn("No LLM credentials found -> falling back to MOCK mode. See README 'Run with a real LLM'.")
	return mock()
}

/**
 * Production hardening around any InferenceRunner:
 *  - bounded parallelism (so 12+ concurrent agent loops don't trip provider rate limits)
 *  - retries with backoff
 *  - strips <think> blocks some reasoning models inline
 *  - never throws: a failed call becomes an assistant message with {"error": ...} so the
 *    Mozaik loop reaches `model.answer` and the team can degrade gracefully.
 */
export class SafeRunner implements InferenceRunner {
	private active = 0
	private readonly queue: (() => void)[] = []
	constructor(
		private readonly inner: InferenceRunner,
		private readonly maxParallel = 64,
		private readonly retries = 2,
	) {}

	private async slot<T>(fn: () => Promise<T>): Promise<T> {
		if (this.active >= this.maxParallel) await new Promise<void>((r) => this.queue.push(r))
		this.active++
		try {
			return await fn()
		} finally {
			this.active--
			this.queue.shift()?.()
		}
	}

	async run(request: InferenceInput): Promise<InferenceOutput> {
		let lastErr: unknown
		for (let attempt = 0; attempt <= this.retries; attempt++) {
			try {
				const out = await this.slot(() => this.inner.run(request))
				return { ...out, items: out.items.map(clean) }
			} catch (e) {
				lastErr = e
				await new Promise((r) => setTimeout(r, 800 * (attempt + 1)))
			}
		}
		const msg = String((lastErr as Error)?.message ?? lastErr).slice(0, 300)
		return { items: [ModelMessageItem.rehydrate({ text: JSON.stringify({ error: msg }) })], tokenUsage: undefined, rowResponse: null }
	}

	stream(request: InferenceInput): AsyncGenerator<SemanticEvent> {
		return this.inner.stream(request)
	}
}

function clean<T>(item: T): T {
	const anyItem = item as any
	if (anyItem?.type === "message" && anyItem?.role === "assistant") {
		const text: string = anyItem.content?.text ?? ""
		const stripped = text.replace(/<think>[\s\S]*?<\/think>/g, "").trim()
		if (stripped !== text) return ModelMessageItem.rehydrate({ text: stripped }) as T
	}
	return item
}

/** Routes an InferenceInput to the GenerativeModel (endpoint + specification) with the same name. */
export class ModelRouter implements InferenceRunner {
	constructor(private readonly models: GenerativeModel[]) {}
	private find(name: string) {
		const m = this.models.find((x) => x.specification.name === name)
		if (!m) throw new Error(`Unsupported model: ${name}`)
		return m
	}
	run(request: InferenceInput) {
		return this.find(request.model).endpoint.infer(request)
	}
	async *stream(request: InferenceInput): AsyncGenerator<SemanticEvent> {
		yield* this.find(request.model).endpoint.stream(request) as AsyncIterable<SemanticEvent>
	}
}

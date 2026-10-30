/**
 * MockInferenceRunner – a drop-in Mozaik InferenceRunner that needs no API key.
 *
 * It is NOT a canned transcript: it behaves like a tool-using model. On each inference it inspects
 * the ModelContext (role tag in the developer message, the user task, and the tool outputs so far),
 * then either emits a FunctionCallItem (the real Mozaik loop executes the real tool) or composes a
 * final answer from the tool outputs. Latency is randomised (0.4–1.6 s per call) so the concurrency
 * of the runtime is visible exactly as it would be with a real provider.
 */
import {
	FunctionCallItem,
	FunctionCallOutputItem,
	ModelMessageItem,
	UserMessageItem,
	DeveloperMessageItem,
	type InferenceInput,
	type InferenceOutput,
	type InferenceRunner,
	type SemanticEvent,
} from "@mozaik-ai/core"
import { lintListing } from "./lint"

let seed = Number(process.env.MOCK_SEED ?? 42)
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const titleCase = (s: string) => s.replace(/\b\w/g, (c) => c.toUpperCase())

export class MockInferenceRunner implements InferenceRunner {
	private calls = 0

	async run(input: InferenceInput): Promise<InferenceOutput> {
		await sleep(400 + rand() * 1200)
		const items = input.context.getItems()
		const dev = items.find((i) => i instanceof DeveloperMessageItem) as DeveloperMessageItem | undefined
		const role = dev?.content.text.match(/\[\[role:(\w+)\]\]/)?.[1] ?? "unknown"
		const user = (items.filter((i) => i instanceof UserMessageItem).at(-1) as UserMessageItem | undefined)?.content.text ?? ""
		const sku = user.match(/^SKU: (\S+)/)?.[1] ?? ""
		const outputs = items
			.filter((i): i is FunctionCallOutputItem => i instanceof FunctionCallOutputItem)
			.map((o) => safeJson(o.output.text))
		const blocks = Object.fromEntries([...user.matchAll(/(\w+)[^:\n]*:\n```json\n([\s\S]*?)\n```/g)].map((m) => [m[1], safeJson(m[2])]))

		const step = outputs.length
		const call = (name: string, args: object) => this.fc(name, args)
		const answer = (obj: object) => this.msg(obj)

		switch (role) {
			case "researcher": {
				if (step === 0) return call("get_product_spec", { sku })
				if (step === 1) return call("review_stats", { sku })
				if (step === 2) return call("search_knowledge_base", { sku, query: "quality compact easy durable problem" })
				const [spec, stats, hits] = outputs
				const features = Object.entries(spec.specs as Record<string, string>)
					.slice(0, 5)
					.map(([k, v]) => `${titleCase(k.replace(/_/g, " "))}: ${v}`)
				return answer({
					key_features: features,
					customer_praise: stats.praise.slice(0, 3),
					customer_pains: stats.complaints,
					risky_merchant_claims: spec.marketing_claims,
					audience: `Shoppers in ${spec.category.split(" > ").slice(-1)[0]} who value ${features[0].split(":")[0].toLowerCase()}`,
					evidence_ids: (hits as any[]).map((h) => h.id),
				})
			}
			case "pricing": {
				if (step === 0) return call("get_competitor_prices", { sku })
				const comp = outputs[0]
				if (step === 1) {
					const candidate = Math.floor(comp.median * 0.92) + 0.99
					return call("simulate_price", { sku, price_usd: +candidate.toFixed(2) })
				}
				const last = outputs[step - 1]
				if (!last.meets_target && step < 4) {
					const cost = last.unit_cost_usd
					const floor = cost / (1 - 0.15 - last.target_margin)
					return call("simulate_price", { sku, price_usd: Math.ceil(floor) + 0.49 })
				}
				return answer({
					recommended_price_usd: last.price_usd,
					gross_margin: last.gross_margin,
					meets_target: last.meets_target,
					positioning: last.price_usd < comp.median * 0.8 ? "budget" : last.price_usd <= comp.median ? "value" : "premium",
					competitor_median_usd: comp.median,
					rationale: `Median competitor price is $${comp.median}; $${last.price_usd} yields ${(last.gross_margin * 100).toFixed(1)}% gross margin after the 15% fee (target ${(last.target_margin * 100).toFixed(0)}%) and undercuts ${last.cheaper_than_competitors} competitors.`,
				})
			}
			case "seo": {
				if (step === 0) return call("keyword_research", { sku })
				const kws = outputs[0] as any[]
				const longTail = kws.filter((k) => k.competition !== "high").map((k) => k.keyword)
				return answer({
					primary_keyword: kws[0].keyword,
					secondary_keywords: kws.slice(1).map((k) => k.keyword),
					title_keywords: [kws[0].keyword, ...longTail.slice(0, 2)],
					backend_search_terms: [...new Set(kws.flatMap((k) => k.keyword.split(" ")))].join(" ").slice(0, 250),
				})
			}
			case "copywriter":
				return answer(this.writeCopy(blocks))
			case "compliance": {
				const draft = blocks.LISTING_DRAFT ?? {}
				if (step === 0) return call("lint_listing", { listing_json: JSON.stringify(draft) })
				const lint = outputs[0]
				if (step === 1 && !lint.ok) return call("search_policies", { query: lint.issues.map((i: any) => i.message).join(" ") })
				return answer({
					verdict: lint.ok ? "APPROVE" : "REVISE",
					issues: lint.issues.map((i: any) => `[${i.rule}] ${i.field}: ${i.message} – rewrite "${i.excerpt}"`),
					notes: lint.ok ? "Claims are backed by specs and reviews; limitations disclosed." : "See cited policy sections.",
				})
			}
		}
		return answer({ error: `mock has no script for role ${role}` })
	}

	private writeCopy(b: Record<string, any>) {
		const product = b.PRODUCT
		const claims: string[] = b.MERCHANT_CLAIMS ?? []
		const research = b.RESEARCH ?? {}
		const seo = b.SEO ?? {}
		const feats: string[] = research.key_features ?? []
		if (b.PREVIOUS_DRAFT) {
			// Revision: replace every bullet / sentence the policy linter flags, keep everything else.
			const prev = b.PREVIOUS_DRAFT
			const flagged = (text: string) => lintListing({ title: "Ok", bullets: [text, "a", "b"], description: "x".repeat(400) }).issues.some((i) => i.field === "bullet_1")
			const spare = feats.slice(4).map(bulletFromFeature)
			const pains: string[] = research.customer_pains ?? []
			const bullets = (prev.bullets as string[]).map((x) => (flagged(x) ? (spare.shift() ?? `Good to know – ${pains[0] ?? "see description"}`) : x))
			const sentences = String(prev.description).split(/(?<=[.!?]"?)\s+/)
			const description = sentences.filter((x) => !flagged(x)).join(" ")
			return { ...prev, bullets, description }
		}
		const kw = (seo.title_keywords ?? []).map(titleCase)
		const title = `${product.brand} ${product.name} – ${kw.slice(0, 2).join(", ")}`.slice(0, 150)
		const bullets = [
			// A naive first draft that echoes the merchant's favourite claim – Compliance should catch it.
			`${claims[0]}: ${feats[0] ?? ""}`,
			...feats.slice(1, 4).map(bulletFromFeature),
		]
		const pains: string[] = research.customer_pains ?? []
		const description = [
			`${product.name} by ${product.brand} is built for ${String(research.audience ?? "everyday use").toLowerCase()}.`,
			`Highlights: ${feats.map((f) => f.split(":").slice(1).join(":").trim()).join("; ")}.`,
			`Customers say: "${String((research.customer_praise ?? [])[0] ?? "").replace(/\.$/, "")}."`,
			`${claims[1] ?? ""}.`,
			pains.length ? `Good to know: ${pains.slice(0, 2).map((p) => p.replace(/\.$/, "")).join("; ")}.` : "",
		].join(" ")
		return { title, bullets, description, search_terms: seo.backend_search_terms }
	}

	private fc(name: string, args: object): InferenceOutput {
		return { items: [FunctionCallItem.rehydrate({ callId: `mock_${++this.calls}`, name, args: JSON.stringify(args) })], tokenUsage: undefined, rowResponse: null }
	}
	private msg(obj: object): InferenceOutput {
		return { items: [ModelMessageItem.rehydrate({ text: JSON.stringify(obj) })], tokenUsage: undefined, rowResponse: null }
	}
	async *stream(): AsyncGenerator<SemanticEvent> {
		throw new Error("MockInferenceRunner does not stream")
	}
}

const bulletFromFeature = (f: string) => `${f.split(":")[0]} – ${f.split(":").slice(1).join(":").trim()}`

function safeJson(s: string): any {
	try {
		return JSON.parse(s)
	} catch {
		return { raw: s }
	}
}

/**
 * The listing team. Every agent is a Mozaik participant that *reacts* to semantic events on the
 * shared runtime – nobody orchestrates them. Agents start Mozaik loops (runLoop) which run
 * concurrently: 3 SKUs x (Researcher, Pricing, SEO) = 9 loops in flight at t=0, then Copywriter
 * and Compliance loops fan in per SKU as soon as that SKU's prerequisites appear on the board.
 */
import {
	createAgent,
	DeveloperMessageItem,
	ModelContext,
	type Agent,
	type InterceptionHandler,
	type SituationHandler,
} from "@mozaik-ai/core"
import { jsonrepair } from "jsonrepair"
import { getProduct } from "./kb"
import { lintListing } from "./lint"
import { emit, EV, EventIs, runLoop, state, type Section, type SectionReadyPayload, type VerdictPayload } from "./runtime"
import * as T from "./tools"

export const MAX_REVISIONS = Number(process.env.MAX_REVISIONS ?? 2)
let MODEL = "mock-model"
export const setModel = (m: string) => (MODEL = m)

// ---------------------------------------------------------------------------------------------
// helpers

/** Pull the first JSON object out of a model answer (tolerates prose / ```json fences). */
export function parseJson(text: string): any {
	const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
	const body = fenced ? fenced[1] : text
	const start = body.indexOf("{")
	const end = body.lastIndexOf("}")
	if (start < 0 || end < start) return { raw: text }
	const candidate = body.slice(start, end + 1)
	try {
		return JSON.parse(candidate)
	} catch {
		try {
			return JSON.parse(jsonrepair(candidate)) // unescaped quotes, trailing commas, comments …
		} catch {
			return { raw: text }
		}
	}
}

/**
 * Start one Mozaik agent loop for a SKU-scoped task.
 * - Each loop gets a fresh ModelContext seeded with the agent's instruction, so the same agent can
 *   work on several SKUs at once without their conversations bleeding into each other.
 * - An InterceptionHandler catches the `model_message` transition and hands the answer back to the
 *   caller, which writes it to the shared board and publishes a domain event.
 */
function think(agent: Agent, sku: string, task: string, message: string, onAnswer: (text: string) => void, attempt = 0) {
	const context = ModelContext.create().addContextItem(DeveloperMessageItem.create(agent.getDeveloperMessage()))
	const capture: InterceptionHandler = {
		isSatisfiedBy: (t) => t.nextStateId === "model_message",
		async handle(t) {
			if (t.nextStateId !== "model_message") return t
			const text = t.input.answer.content.text
			if (parseJson(text).raw !== undefined && attempt < 1) {
				// Self-repair: ask the same agent (new loop) to re-emit its answer as valid JSON.
				const fix = `Your previous answer for this task was not a valid JSON object. Re-send the SAME content as ONE valid JSON object in the required schema, nothing else.\n\nPREVIOUS ANSWER:\n${text.slice(0, 6000)}\n\nORIGINAL TASK:\n${message}`
				think(agent, sku, `${task}+fix`, fix, onAnswer, attempt + 1)
			} else onAnswer(text)
			return t
		},
	}
	runLoop(agent.getId(), `SKU: ${sku}\nTASK: ${task}\n\n${message}`, { model: MODEL, context, tools: agent.getTools() }, capture)
}

const board = (sku: string) => {
	const b = state().boards.get(sku)
	if (!b) throw new Error(`No board for ${sku}`)
	return b
}

function completeSection(agent: Agent, sku: string, section: Section, text: string, round?: number) {
	const b = board(sku)
	b[section] = parseJson(text)
	b.sectionReadyAt[section] = Date.now()
	emit<SectionReadyPayload>(EV.sectionReady, agent.getId(), { sku, section, round })
}

const block = (label: string, obj: unknown) => `${label}:\n\`\`\`json\n${JSON.stringify(obj, null, 2)}\n\`\`\``

const JSON_ONLY = "Reply with ONE JSON object only, no prose, no markdown fences."

// ---------------------------------------------------------------------------------------------
// 1. Market Researcher  (RAG over specs + reviews)

export function createResearcher() {
	const onBrief: SituationHandler = {
		specification: new EventIs(EV.brief),
		processor: {
			apply({ event, participant }) {
				const { sku } = event.payload as { sku: string }
				const me = participant as Agent
				think(me, sku, "research", "Research this product for its marketplace listing. Use your tools to gather specs and customer evidence.", (text) =>
					completeSection(me, sku, "research", text),
				)
			},
		},
	}
	return createAgent({
		name: "Researcher",
		capabilities: ["inference", "rag", "research"],
		instruction: `[[role:researcher]]
You are the Market Researcher in an e-commerce listing team. Ground everything in evidence from your tools
(get_product_spec, review_stats, search_knowledge_base). Never invent specs.
${JSON_ONLY} Schema:
{"key_features": string[5] (benefit + the spec that proves it),
 "customer_praise": string[] (short, paraphrased from reviews),
 "customer_pains": string[] (limitations buyers should know),
 "risky_merchant_claims": string[] (merchant claims that look unverifiable, medical, absolute or mention competitors),
 "audience": string,
 "evidence_ids": string[]}`,
		tools: [T.getProductSpec, T.reviewStats, T.searchKnowledgeBase],
		handlers: [onBrief],
	})
}

// ---------------------------------------------------------------------------------------------
// 2. Pricing Strategist

export function createPricing() {
	const onBrief: SituationHandler = {
		specification: new EventIs(EV.brief),
		processor: {
			apply({ event, participant }) {
				const { sku } = event.payload as { sku: string }
				const me = participant as Agent
				think(me, sku, "pricing", "Recommend a launch price. Check competitors, then simulate at least one candidate price.", (text) =>
					completeSection(me, sku, "pricing", text),
				)
			},
		},
	}
	return createAgent({
		name: "Pricing",
		capabilities: ["inference", "pricing"],
		instruction: `[[role:pricing]]
You are the Pricing Strategist. Use get_competitor_prices and simulate_price (it includes a 15% marketplace fee).
The price must meet the SKU's target gross margin and end in .99 or .49. Prefer being below the competitor median
when margin allows. ${JSON_ONLY} Schema:
{"recommended_price_usd": number, "gross_margin": number, "meets_target": boolean,
 "positioning": "budget"|"value"|"premium", "competitor_median_usd": number, "rationale": string}`,
		tools: [T.getCompetitorPrices, T.simulatePrice],
		handlers: [onBrief],
	})
}

// ---------------------------------------------------------------------------------------------
// 3. SEO Strategist

export function createSeo() {
	const onBrief: SituationHandler = {
		specification: new EventIs(EV.brief),
		processor: {
			apply({ event, participant }) {
				const { sku } = event.payload as { sku: string }
				const me = participant as Agent
				const p = getProduct(sku)
				think(me, sku, "seo", `Build the keyword strategy for "${p.name}" (${p.category}).`, (text) => completeSection(me, sku, "seo", text))
			},
		},
	}
	return createAgent({
		name: "SEO",
		capabilities: ["inference", "seo"],
		instruction: `[[role:seo]]
You are the SEO Strategist for marketplace search. Use keyword_research. Balance volume against competition:
one high-volume primary keyword plus low-competition long-tail terms. ${JSON_ONLY} Schema:
{"primary_keyword": string, "secondary_keywords": string[], "title_keywords": string[] (max 3),
 "backend_search_terms": string (space separated, max 250 chars, no brand names of competitors)}`,
		tools: [T.keywordResearch],
		handlers: [onBrief],
	})
}

// ---------------------------------------------------------------------------------------------
// 4. Copywriter – waits (via shared state) for Research + SEO of the same SKU, then drafts.
//    Also reacts to the Compliance agent's REVISE verdicts.

export function createCopywriter() {
	const draft = (me: Agent, sku: string) => {
		const b = board(sku)
		b.copyInFlight = true
		const round = b.copyRound
		const { marketing_claims, ...product } = b.product
		const msg =
			round === 0
				? [
						"Write the first draft of the listing.",
						block("PRODUCT", product),
						block("MERCHANT_CLAIMS (merchant wants these used)", marketing_claims),
						block("RESEARCH", b.research),
						block("SEO", b.seo),
					].join("\n\n")
				: [
						`Revise your listing (revision ${round}). Fix EVERY issue raised by Compliance, keep everything else.`,
						block("PREVIOUS_DRAFT", b.copy),
						block("COMPLIANCE_ISSUES", b.reviews.at(-1)?.issues ?? []),
						block("RESEARCH", b.research),
						block("SEO", b.seo),
					].join("\n\n")
		think(me, sku, round === 0 ? "draft" : `revise#${round}`, msg, (text) => {
			b.copyInFlight = false
			completeSection(me, sku, "copy", text, round)
		})
	}

	const whenPrereqsReady: SituationHandler = {
		specification: new EventIs(EV.sectionReady, (p: SectionReadyPayload) => p.section === "research" || p.section === "seo"),
		processor: {
			apply({ event, participant }) {
				const { sku } = event.payload as SectionReadyPayload
				const b = board(sku)
				if (b.research && b.seo && !b.copy && !b.copyInFlight) draft(participant as Agent, sku)
			},
		},
	}
	const whenRevisionRequested: SituationHandler = {
		specification: new EventIs(EV.verdict, (p: VerdictPayload) => p.verdict === "REVISE" && p.round < MAX_REVISIONS),
		processor: {
			apply({ event, participant }) {
				const { sku } = event.payload as VerdictPayload
				board(sku).copyRound++
				draft(participant as Agent, sku)
			},
		},
	}
	return createAgent({
		name: "Copywriter",
		capabilities: ["inference", "copywriting"],
		instruction: `[[role:copywriter]]
You are the senior marketplace Copywriter. Write a high-converting, honest listing grounded in RESEARCH and SEO.
Use search_knowledge_base if you need more evidence. Do not mention price. Title starts with the brand, max 150 chars,
includes the primary keyword. 3-5 bullets (max 220 chars each) that lead with a benefit backed by a spec.
Description 400-1200 chars and honestly sets expectations about known limitations.
${JSON_ONLY} Schema: {"title": string, "bullets": string[], "description": string, "search_terms": string}`,
		tools: [T.searchKnowledgeBase],
		handlers: [whenPrereqsReady, whenRevisionRequested],
	})
}

// ---------------------------------------------------------------------------------------------
// 5. Compliance Critic – reviews every copy draft as soon as it lands on the board.

export function createCompliance() {
	const onCopy: SituationHandler = {
		specification: new EventIs(EV.sectionReady, (p: SectionReadyPayload) => p.section === "copy"),
		processor: {
			apply({ event, participant }) {
				const { sku, round = 0 } = event.payload as SectionReadyPayload
				const me = participant as Agent
				const b = board(sku)
				const msg = [
					`Review listing draft round ${round}. Run lint_listing on it, consult search_policies when unsure, and check claims against RESEARCH.`,
					block("LISTING_DRAFT", b.copy),
					block("RESEARCH", b.research),
				].join("\n\n")
				think(me, sku, `review#${round}`, msg, (text) => {
					const out = parseJson(text)
					// Guardrail: the deterministic linter has veto power over the LLM's verdict.
					const lint = lintListing(b.copy ?? {})
					const issues: string[] = [...(Array.isArray(out.issues) ? out.issues.map(String) : [])]
					for (const i of lint.issues) {
						const s = `[${i.rule}] ${i.field}: ${i.message} ("${i.excerpt}")`
						if (!issues.some((x) => x.includes(i.field) && x.includes(i.rule))) issues.push(s)
					}
					const verdict = lint.ok && out.verdict === "APPROVE" ? "APPROVE" : issues.length ? "REVISE" : "APPROVE"
					const v = { round, verdict, issues, notes: out.notes, by: me.getId() } as const
					b.reviews.push(v)
					if (verdict === "APPROVE" || round >= MAX_REVISIONS) b.approved = true
					emit<VerdictPayload>(EV.verdict, me.getId(), { sku, ...v })
				})
			},
		},
	}
	return createAgent({
		name: "Compliance",
		capabilities: ["inference", "policy", "qa"],
		instruction: `[[role:compliance]]
You are the Compliance & QA Critic for a marketplace. Be strict but fair: flag unverifiable superlatives, medical claims,
absolute guarantees, competitor mentions, format violations and claims not supported by RESEARCH evidence.
Always call lint_listing first (pass the draft as a JSON string). ${JSON_ONLY} Schema:
{"verdict": "APPROVE"|"REVISE", "issues": string[] (each: "[rule] field: what to change"), "notes": string}`,
		tools: [T.lintListingTool, T.searchPolicies],
		handlers: [onCopy],
	})
}

/**
 * Mozaik FunctionTools. Each agent only gets the tools that match its role,
 * so the "team" is real specialisation, not one agent with a pile of tools.
 */
import type { Tool } from "@mozaik-ai/core"
import { competitors, getProduct, kb, keywords, reviews } from "./kb"
import { lintListing } from "./lint"

const tool = (name: string, description: string, properties: Record<string, any>, invoke: (a: any) => Promise<any>): Tool => ({
	type: "function",
	name,
	description,
	parameters: { type: "object", properties, required: Object.keys(properties), additionalProperties: false },
	strict: true,
	invoke,
})

export const getProductSpec = tool(
	"get_product_spec",
	"Return the merchant's raw product record (specs, cost, merchant marketing claims) for a SKU.",
	{ sku: { type: "string", description: "Product SKU, e.g. ESP-01" } },
	async ({ sku }) => getProduct(sku),
)

export const searchKnowledgeBase = tool(
	"search_knowledge_base",
	"BM25 search over product specs and customer reviews for one SKU. Use it to find evidence, praise and complaints.",
	{ sku: { type: "string" }, query: { type: "string", description: "What to look for" } },
	async ({ sku, query }) =>
		kb.search(query, { k: 6, filter: (d) => d.sku === String(sku).toUpperCase() }).map(({ d, score }) => ({
			id: d.id,
			kind: d.kind,
			rating: d.meta?.rating,
			text: d.text,
			score: +score.toFixed(2),
		})),
)

export const reviewStats = tool(
	"review_stats",
	"Aggregate customer review statistics for a SKU (average rating, count, lowest-rated reviews).",
	{ sku: { type: "string" } },
	async ({ sku }) => {
		const rs = reviews.filter((r) => r.sku === String(sku).toUpperCase())
		const avg = rs.reduce((a, r) => a + r.rating, 0) / Math.max(1, rs.length)
		return {
			count: rs.length,
			average_rating: +avg.toFixed(2),
			complaints: rs.filter((r) => r.rating <= 3).map((r) => r.text),
			praise: rs.filter((r) => r.rating >= 4).map((r) => r.text),
		}
	},
)

export const getCompetitorPrices = tool(
	"get_competitor_prices",
	"Competitor offers for a SKU's category: price, rating, review count.",
	{ sku: { type: "string" } },
	async ({ sku }) => {
		const list = competitors.filter((c) => c.sku === String(sku).toUpperCase())
		const prices = list.map((c) => c.price_usd).sort((a, b) => a - b)
		const median = prices.length ? (prices[(prices.length - 1) >> 1] + prices[prices.length >> 1]) / 2 : 0
		return { offers: list, min: prices[0], max: prices[prices.length - 1], median: +median.toFixed(2) }
	},
)

export const simulatePrice = tool(
	"simulate_price",
	"Simulate a candidate retail price: returns gross margin vs target and position vs competitors (percentile).",
	{ sku: { type: "string" }, price_usd: { type: "number" } },
	async ({ sku, price_usd }) => {
		const p = getProduct(sku)
		const fees = +(price_usd * 0.15).toFixed(2) // marketplace referral fee
		const margin = (price_usd - fees - p.unit_cost_usd) / price_usd
		const comp = competitors.filter((c) => c.sku === p.sku).map((c) => c.price_usd)
		const cheaperThan = comp.filter((c) => c > price_usd).length
		return {
			price_usd,
			marketplace_fee_usd: fees,
			unit_cost_usd: p.unit_cost_usd,
			gross_margin: +margin.toFixed(3),
			target_margin: p.target_margin,
			meets_target: margin >= p.target_margin,
			cheaper_than_competitors: `${cheaperThan}/${comp.length}`,
		}
	},
)

export const keywordResearch = tool(
	"keyword_research",
	"Search-volume and competition data for keywords related to a SKU.",
	{ sku: { type: "string" } },
	async ({ sku }) => keywords.filter((k) => k.sku === String(sku).toUpperCase()).sort((a, b) => b.monthly_searches - a.monthly_searches),
)

export const lintListingTool = tool(
	"lint_listing",
	"Run the deterministic marketplace policy linter on a listing draft. Pass the draft as a JSON string with title, bullets[], description.",
	{ listing_json: { type: "string" } },
	async ({ listing_json }) => {
		let draft: any
		try {
			draft = JSON.parse(listing_json)
		} catch {
			return { ok: false, issues: [{ rule: "FORMAT", field: "listing", message: "listing_json is not valid JSON" }] }
		}
		return lintListing(draft)
	},
)

export const searchPolicies = tool(
	"search_policies",
	"Retrieve the most relevant marketplace policy sections for a question (RAG over the policy handbook).",
	{ query: { type: "string" } },
	async ({ query }) => kb.search(query, { k: 2, filter: (d) => d.kind === "policy" }).map(({ d }) => d.text),
)

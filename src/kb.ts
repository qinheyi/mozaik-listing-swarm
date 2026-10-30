/**
 * Tiny local knowledge base + BM25 retriever (RAG without external services).
 * Indexes product specs, customer reviews and the marketplace policy so agents
 * can ground their output in evidence via tool calls.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"

const DATA_DIR = join(__dirname, "..", "data")
const readJson = <T>(f: string): T => JSON.parse(readFileSync(join(DATA_DIR, f), "utf8"))

export type Product = {
	sku: string
	name: string
	brand: string
	category: string
	unit_cost_usd: number
	target_margin: number
	specs: Record<string, string>
	marketing_claims: string[]
}
export type Review = { sku: string; rating: number; text: string }
export type Competitor = { sku: string; competitor: string; price_usd: number; rating: number; reviews: number }
export type Keyword = { sku: string; keyword: string; monthly_searches: number; competition: string }

export const products = readJson<Product[]>("products.json")
export const reviews = readJson<Review[]>("reviews.json")
export const competitors = readJson<Competitor[]>("competitors.json")
export const keywords = readJson<Keyword[]>("keywords.json")
export const policyText = readFileSync(join(DATA_DIR, "policies.md"), "utf8")

export type Doc = { id: string; kind: "spec" | "review" | "policy"; sku?: string; text: string; meta?: Record<string, unknown> }

function buildDocs(): Doc[] {
	const docs: Doc[] = []
	for (const p of products) {
		for (const [k, v] of Object.entries(p.specs)) {
			docs.push({ id: `spec:${p.sku}:${k}`, kind: "spec", sku: p.sku, text: `${p.name} ${k.replace(/_/g, " ")}: ${v}` })
		}
	}
	reviews.forEach((r, i) =>
		docs.push({ id: `review:${r.sku}:${i}`, kind: "review", sku: r.sku, text: r.text, meta: { rating: r.rating } }),
	)
	for (const section of policyText.split(/\n## /).slice(1)) {
		const [title] = section.split("\n")
		docs.push({ id: `policy:${title.split(" ")[0]}`, kind: "policy", text: `## ${section.trim()}` })
	}
	return docs
}

const tokenize = (s: string) =>
	s
		.toLowerCase()
		.replace(/[^a-z0-9#%\s-]/g, " ")
		.split(/\s+/)
		.filter((t) => t.length > 1)

/** Okapi BM25 over the in-memory corpus. */
export class Bm25Index {
	private readonly tf: Map<string, number>[]
	private readonly df = new Map<string, number>()
	private readonly lens: number[]
	private readonly avgLen: number
	constructor(
		readonly docs: Doc[],
		private readonly k1 = 1.4,
		private readonly b = 0.75,
	) {
		this.tf = docs.map((d) => {
			const m = new Map<string, number>()
			for (const t of tokenize(d.text)) m.set(t, (m.get(t) ?? 0) + 1)
			for (const t of m.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1)
			return m
		})
		this.lens = this.tf.map((m) => [...m.values()].reduce((a, b) => a + b, 0))
		this.avgLen = this.lens.reduce((a, b) => a + b, 0) / Math.max(1, this.lens.length)
	}
	search(query: string, opts: { k?: number; filter?: (d: Doc) => boolean } = {}) {
		const q = tokenize(query)
		const N = this.docs.length
		const scored = this.docs
			.map((d, i) => {
				if (opts.filter && !opts.filter(d)) return { d, score: -1 }
				let score = 0
				for (const t of q) {
					const f = this.tf[i].get(t)
					if (!f) continue
					const df = this.df.get(t) ?? 0
					const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5))
					score += (idf * f * (this.k1 + 1)) / (f + this.k1 * (1 - this.b + (this.b * this.lens[i]) / this.avgLen))
				}
				return { d, score }
			})
			.filter((x) => x.score >= 0)
			.sort((a, b) => b.score - a.score)
		return scored.slice(0, opts.k ?? 5)
	}
}

export const kb = new Bm25Index(buildDocs())

export const getProduct = (sku: string) => {
	const p = products.find((x) => x.sku.toLowerCase() === String(sku).toLowerCase())
	if (!p) throw new Error(`Unknown SKU ${sku}`)
	return p
}

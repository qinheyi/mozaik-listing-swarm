/** Deterministic policy linter used as a tool by the Compliance agent. */
export type ListingDraft = { title?: string; bullets?: string[]; description?: string }
export type LintIssue = { rule: string; field: string; excerpt: string; message: string }

const SUPERLATIVES = /(#1\b|\b(best|number one|top[- ]rated|world'?s finest|better than)\b)/i
const MEDICAL = /\b(cures?|heals?|treats? (blisters?|pain|strain)|eliminates? (eye ?strain|pain|blisters?|headaches?))\b|\bprevents? (blisters?|eye ?strain|headaches?|injur)/i
const ABSOLUTE = /(100%|\bnever\b|\bguarantee(d)?\b|\bforever\b)/i
const COMPETITORS = /\b(benq|darn tough|smartwool|wacaco|nanopresso|staresso|outin|taotronics|xiaomi|lepro|danish endurance)\b/i
const PROMO = /\b(sale|free shipping|deal|cheap|discount)\b/i
const CONTACT = /(\$\s?\d|https?:\/\/|www\.|@[a-z0-9-]+\.[a-z]|\+?\d[\d\s-]{8,}\d)/i

export function lintListing(listing: ListingDraft): { ok: boolean; issues: LintIssue[] } {
	const issues: LintIssue[] = []
	const fields: [string, string][] = [
		["title", listing.title ?? ""],
		...(listing.bullets ?? []).map((b, i) => [`bullet_${i + 1}`, b] as [string, string]),
		["description", listing.description ?? ""],
	]
	const check = (re: RegExp, rule: string, message: string) => {
		for (const [field, text] of fields) {
			const m = text.match(re)
			if (m) issues.push({ rule, field, excerpt: around(text, m.index ?? 0), message })
		}
	}
	check(SUPERLATIVES, "P1", "Unverifiable superlative/ranking")
	check(MEDICAL, "P2", "Medical or health claim")
	check(ABSOLUTE, "P3", "Absolute guarantee")
	check(COMPETITORS, "P4", "Competitor brand mentioned")
	const title = listing.title ?? ""
	if (title.length > 150) issues.push({ rule: "P5", field: "title", excerpt: title.slice(0, 40) + "...", message: `Title is ${title.length} chars (max 150)` })
	if (PROMO.test(title)) issues.push({ rule: "P5", field: "title", excerpt: title, message: "Promotional text in title" })
	const caps = title.match(/\b[A-Z]{5,}\b/)
	if (caps) issues.push({ rule: "P5", field: "title", excerpt: caps[0], message: "ALL CAPS word in title" })
	const bullets = listing.bullets ?? []
	if (bullets.length < 3 || bullets.length > 5) issues.push({ rule: "P6", field: "bullets", excerpt: `${bullets.length} bullets`, message: "Need 3-5 bullets" })
	bullets.forEach((b, i) => {
		if (b.length > 220) issues.push({ rule: "P6", field: `bullet_${i + 1}`, excerpt: b.slice(0, 40) + "...", message: `Bullet is ${b.length} chars (max 220)` })
	})
	const d = listing.description ?? ""
	if (d.length < 300 || d.length > 1500) issues.push({ rule: "P7", field: "description", excerpt: `${d.length} chars`, message: "Description must be 300-1500 chars" })
	if (CONTACT.test(d)) issues.push({ rule: "P7", field: "description", excerpt: around(d, d.search(CONTACT)), message: "Price/URL/contact in description" })
	return { ok: issues.length === 0, issues }
}

function around(text: string, idx: number) {
	return text.slice(Math.max(0, idx - 25), idx + 35).trim()
}

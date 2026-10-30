/**
 * Non-LLM participants: the Merchant (human), the Publisher (assembles + writes listings),
 * and two observers (Telemetry for concurrency metrics, Console for the live feed).
 */
import { createHuman, type SituationHandler } from "@mozaik-ai/core"
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs"
import { join } from "node:path"
import { AnyEvent, emit, EV, EventIs, state, type PublishedPayload, type SectionReadyPayload, type VerdictPayload } from "./runtime"

export const OUT_DIR = join(__dirname, "..", "out")

export function createMerchant() {
	return createHuman({ name: "Merchant", capabilities: ["briefs"], handlers: [] })
}

// ---------------------------------------------------------------------------------------------
// Publisher: publishes a SKU the moment it is both compliance-approved and priced –
// whichever of the two events arrives last triggers it.

export function createPublisher(onAllDone: () => void) {
	const tryPublish: SituationHandler = {
		specification: new EventIs(EV.verdict).or(new EventIs(EV.sectionReady, (p: SectionReadyPayload) => p.section === "pricing")),
		processor: {
			apply({ event, participant }) {
				const { sku } = event.payload as { sku: string }
				const b = state().boards.get(sku)
				if (!b || b.published || !b.approved || !b.pricing) return
				b.published = true
				const last = b.reviews.at(-1)
				const warnings = last?.verdict === "APPROVE" ? [] : (last?.issues ?? ["not reviewed"])
				const file = writeListing(sku, warnings)
				emit<PublishedPayload>(EV.published, participant.getId(), { sku, file, warnings })
				const all = [...state().boards.values()]
				if (all.every((x) => x.published)) {
					emit(EV.allDone, participant.getId(), { skus: all.map((x) => x.sku) })
					onAllDone()
				}
			},
		},
	}
	return createHuman({ name: "Publisher", capabilities: ["publish"], handlers: [tryPublish] })
}

function writeListing(sku: string, warnings: string[]) {
	const b = state().boards.get(sku)!
	const c = b.copy ?? {}
	const pr = b.pricing ?? {}
	const dir = join(OUT_DIR, "listings")
	mkdirSync(dir, { recursive: true })
	const json = {
		sku,
		product: b.product.name,
		title: c.title,
		bullets: c.bullets,
		description: c.description,
		search_terms: c.search_terms ?? b.seo?.backend_search_terms,
		price_usd: pr.recommended_price_usd,
		pricing: pr,
		seo: b.seo,
		research: b.research,
		compliance_history: b.reviews,
		warnings,
	}
	writeFileSync(join(dir, `${sku}.json`), JSON.stringify(json, null, 2))
	const md = [
		`# ${c.title ?? b.product.name}`,
		``,
		`**SKU:** ${sku}  |  **Price:** $${pr.recommended_price_usd ?? "?"}  |  **Margin:** ${pr.gross_margin ?? "?"}  |  **Positioning:** ${pr.positioning ?? "?"}`,
		``,
		...(c.bullets ?? []).map((x: string) => `- ${x}`),
		``,
		c.description ?? "",
		``,
		`**Search terms:** ${json.search_terms ?? ""}`,
		``,
		`## How the team got here`,
		`- Compliance rounds: ${b.reviews.map((r) => `round ${r.round}: ${r.verdict}${r.issues.length ? ` (${r.issues.length} issues)` : ""}`).join("; ")}`,
		...b.reviews.flatMap((r) => r.issues.map((i) => `  - r${r.round}: ${i}`)),
		`- Pricing rationale: ${pr.rationale ?? ""}`,
		warnings.length ? `\n> ⚠️ Published after max revisions with open issues:\n${warnings.map((w) => `> - ${w}`).join("\n")}` : "",
	].join("\n")
	const file = join(dir, `${sku}.md`)
	writeFileSync(file, md)
	return file
}

// ---------------------------------------------------------------------------------------------
// Telemetry observer: reconstructs every agent loop from the raw Mozaik loop events and tracks
// how many loops / model calls were in flight at the same time. Also writes a JSONL event log.

export function createTelemetry() {
	mkdirSync(OUT_DIR, { recursive: true })
	const logFile = join(OUT_DIR, "events.jsonl")
	writeFileSync(logFile, "")
	const handler: SituationHandler = {
		specification: new AnyEvent(),
		processor: {
			apply({ event }) {
				const s = state()
				s.eventCount++
				const p = event.payload as any
				const name = s.getParticipant(event.producerId)?.getManifest().name ?? event.producerId
				appendFileSync(
					logFile,
					JSON.stringify({ t: event.occurredAt.getTime() - s.startedAt, type: event.type, producer: name, loopId: p?.loopId, ...summarize(event.type, p) }) + "\n",
				)
				switch (event.type) {
					case "message_received.started": {
						const content: string = p.content ?? ""
						const sku = content.match(/^SKU: (\S+)/)?.[1] ?? "?"
						const task = content.match(/\nTASK: (\S+)/)?.[1] ?? "?"
						s.loops.set(p.loopId, { loopId: p.loopId, agent: name, sku, task, start: Date.now(), inferences: 0, toolCalls: [] })
						s.activeLoops++
						s.peakActiveLoops = Math.max(s.peakActiveLoops, s.activeLoops)
						break
					}
					case "inference.started":
						s.activeInferences++
						s.peakActiveInferences = Math.max(s.peakActiveInferences, s.activeInferences)
						break
					case "inference.completed": {
						s.activeInferences--
						const l = s.loops.get(p.loopId)
						if (l) l.inferences++
						break
					}
					case "function_call.started": {
						s.loops.get(p.loopId)?.toolCalls.push(p.call?.name)
						break
					}
					case "model.answer": {
						const l = s.loops.get(p.loopId)
						if (l && !l.end) {
							l.end = Date.now()
							s.activeLoops--
						}
						break
					}
				}
			},
		},
	}
	return createHuman({ name: "Telemetry", capabilities: ["observe"], handlers: [handler] })
}

function summarize(type: string, p: any) {
	switch (type) {
		case "function_call.started":
			return { tool: p.call?.name, args: p.call?.args }
		case "function_call.completed":
			return { output: String(p.output?.text ?? "").slice(0, 200) }
		case "model.answer":
			return { answer: String(p.answer?.content?.text ?? "").slice(0, 400) }
		case "message.sent":
		case "brief.submitted":
		case "section.ready":
		case "review.verdict":
		case "listing.published":
		case "batch.completed":
		case "participant.joined":
			return { payload: p }
		default:
			return {}
	}
}

// ---------------------------------------------------------------------------------------------
// Console observer: human-readable live feed with one colour per agent.

const COLORS: Record<string, string> = {
	Researcher: "\x1b[36m",
	Pricing: "\x1b[33m",
	SEO: "\x1b[35m",
	Copywriter: "\x1b[32m",
	Compliance: "\x1b[31m",
	Publisher: "\x1b[34m",
	Merchant: "\x1b[37m",
}
const RESET = "\x1b[0m"

export function createConsoleFeed(verbose: boolean) {
	const handler: SituationHandler = {
		specification: new AnyEvent(),
		processor: {
			apply({ event }) {
				const s = state()
				const p = event.payload as any
				const name = s.getParticipant(event.producerId)?.getManifest().name ?? "?"
				const t = ((event.occurredAt.getTime() - s.startedAt) / 1000).toFixed(1).padStart(6)
				const c = COLORS[name] ?? ""
				const who = `${c}${name.padEnd(10)}${RESET}`
				const loop = p?.loopId ? s.loops.get(p.loopId) : undefined
				const tag = loop ? `[${loop.sku} ${loop.task}]` : ""
				const line = (msg: string) => console.log(`${t}s ${who} ${msg}  (loops in flight: ${s.activeLoops})`)
				switch (event.type) {
					case EV.brief:
						return line(`📝 brief submitted for ${p.sku}`)
					case "message_received.started":
						return line(`▶ starts ${tag}`)
					case "function_call.started":
						return line(`🔧 ${tag} ${p.call?.name}(${String(p.call?.args ?? "").slice(0, 70)})`)
					case "inference.started":
						return verbose ? line(`🧠 ${tag} thinking…`) : undefined
					case EV.sectionReady:
						return line(`✅ ${p.section}${p.round ? ` (rev ${p.round})` : ""} ready for ${p.sku}`)
					case EV.verdict: {
						const v = p as VerdictPayload
						return line(
							`${v.verdict === "APPROVE" ? "🟢 APPROVE" : "🟠 REVISE"} ${v.sku} round ${v.round}${v.issues.length ? `: ${v.issues.slice(0, 3).join(" | ").slice(0, 160)}` : ""}`,
						)
					}
					case EV.published:
						return line(`📦 published ${p.sku} -> ${p.file.replace(/.*\/out\//, "out/")}${p.warnings.length ? " (with warnings)" : ""}`)
				}
			},
		},
	}
	return createHuman({ name: "Console", capabilities: ["observe"], handlers: [handler] })
}

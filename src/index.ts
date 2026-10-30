/**
 * ListingSwarm – a concurrent multi-agent e-commerce listing studio on Mozaik.
 *
 *   npm start                      # auto: live LLM if a key is configured, otherwise mock
 *   npm start -- --mock            # force mock mode (no key, deterministic)
 *   npm start -- --skus=ESP-01     # choose SKUs (default: all in data/products.json)
 *   npm start -- --verbose         # also print every inference start
 */
import "dotenv/config"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { createCompliance, createCopywriter, createPricing, createResearcher, createSeo, setModel, MAX_REVISIONS } from "./agents"
import { getProduct, products } from "./kb"
import { setupLlm } from "./llm"
import { createConsoleFeed, createMerchant, createPublisher, createTelemetry, OUT_DIR } from "./participants"
import { emit, EV, initializeRuntime, join as joinRuntime, state, StudioState, type BriefPayload } from "./runtime"

const args = process.argv.slice(2)
const flag = (n: string) => args.includes(`--${n}`)
const opt = (n: string) => args.find((a) => a.startsWith(`--${n}=`))?.split("=")[1]

// @mozaik-ai/cloud-sdk prints its "no API key" notice once per loop; show it only once.
for (const k of ["log", "warn", "info"] as const) {
	const orig = console[k].bind(console)
	let seen = false
	console[k] = (...a: unknown[]) => {
		if (typeof a[0] === "string" && a[0].startsWith("mozaik cloud:")) {
			if (seen) return
			seen = true
		}
		orig(...a)
	}
}

async function main() {
	const llm = setupLlm(flag("mock"))
	setModel(llm.model)
	const skus = (opt("skus")?.split(",") ?? products.map((p) => p.sku)).map((s) => s.trim().toUpperCase())
	const timeoutMs = Number(opt("timeout") ?? process.env.RUN_TIMEOUT_MS ?? 15 * 60_000)

	console.log(`\n🧩 ListingSwarm on Mozaik — ${llm.label}`)
	console.log(`   SKUs: ${skus.join(", ")}   max compliance revisions: ${MAX_REVISIONS}\n`)

	initializeRuntime({ state: new StudioState(), inferenceRunnerConfig: llm.config })
	for (const sku of skus) {
		state().boards.set(sku, { sku, product: getProduct(sku), copyRound: 0, copyInFlight: false, reviews: [], approved: false, published: false, sectionReadyAt: {} })
	}

	let finish!: () => void
	const done = new Promise<void>((r) => (finish = r))

	// Observers first so they see everything (fan-out follows join order).
	joinRuntime(createTelemetry())
	joinRuntime(createConsoleFeed(flag("verbose")))
	const team = [createResearcher(), createPricing(), createSeo(), createCopywriter(), createCompliance()]
	team.forEach(joinRuntime)
	joinRuntime(createPublisher(() => finish()))
	const merchant = createMerchant()
	joinRuntime(merchant)

	process.on("unhandledRejection", (e) => console.error("⚠️  loop error:", (e as Error)?.message ?? e))

	state().startedAt = Date.now()
	// The merchant drops all briefs at once – every agent picks up work in parallel.
	for (const sku of skus) emit<BriefPayload>(EV.brief, merchant.getId(), { sku })

	const timedOut = await Promise.race([done.then(() => false), new Promise<boolean>((r) => setTimeout(() => r(true), timeoutMs).unref())])
	report(llm.label, skus, timedOut)
	process.exit(0)
}

function report(label: string, skus: string[], timedOut: boolean) {
	const s = state()
	const wall = Date.now() - s.startedAt
	const loops = [...s.loops.values()].filter((l) => l.end)
	const busy = loops.reduce((a, l) => a + (l.end! - l.start), 0)
	const inferences = loops.reduce((a, l) => a + l.inferences, 0)
	const tools = loops.reduce((a, l) => a + l.toolCalls.length, 0)
	const speedup = busy / wall

	const width = 60
	const gantt = loops
		.sort((a, b) => a.start - b.start)
		.map((l) => {
			const a = Math.floor(((l.start - s.startedAt) / wall) * width)
			const b = Math.max(a + 1, Math.ceil(((l.end! - s.startedAt) / wall) * width))
			return `${l.agent.padEnd(10)} ${l.sku.padEnd(7)} ${l.task.padEnd(9)} |${" ".repeat(a)}${"█".repeat(b - a)}${" ".repeat(Math.max(0, width - b))}| ${((l.end! - l.start) / 1000).toFixed(1)}s`
		})

	const stats = [
		`mode                 : ${label}`,
		`SKUs                 : ${skus.join(", ")}${timedOut ? "  (TIMED OUT – partial results)" : ""}`,
		`agent loops          : ${loops.length}  (model calls: ${inferences}, tool calls: ${tools}, events: ${s.eventCount})`,
		`peak concurrent loops: ${s.peakActiveLoops}   peak concurrent model calls: ${s.peakActiveInferences}`,
		`wall-clock           : ${(wall / 1000).toFixed(1)}s   vs. sequential agent time ${(busy / 1000).toFixed(1)}s  →  ${speedup.toFixed(1)}x parallelism`,
	]
	console.log(`\n──────── Concurrency timeline (each bar = one Mozaik agent loop) ────────`)
	console.log(gantt.join("\n"))
	console.log(`\n${stats.join("\n")}`)
	const verdicts = skus.map((sku) => {
		const b = s.boards.get(sku)!
		return `${sku}: ${b.published ? "published" : "NOT published"}, price $${b.pricing?.recommended_price_usd ?? "?"}, compliance ${b.reviews.map((r) => r.verdict).join(" → ") || "-"}`
	})
	console.log(`\n${verdicts.join("\n")}\n\nListings: out/listings/*.md   Event log: out/events.jsonl   Report: out/run-report.md\n`)

	const mermaid = [
		"```mermaid",
		"gantt",
		"    title Agent loops running concurrently on one Mozaik runtime",
		"    dateFormat x",
		"    axisFormat %M:%S",
		...[...new Set(loops.map((l) => l.agent))].flatMap((agent) => [
			`    section ${agent}`,
			...loops.filter((l) => l.agent === agent).map((l) => `    ${l.sku} ${l.task} :${l.start - s.startedAt}, ${Math.max(l.end! - s.startedAt, l.start - s.startedAt + 1)}`),
		]),
		"```",
	].join("\n")
	writeFileSync(
		join(OUT_DIR, "run-report.md"),
		[`# ListingSwarm run report`, "", ...stats.map((x) => `- ${x}`), "", ...verdicts.map((v) => `- ${v}`), "", "## Timeline", "", mermaid, "", "```", ...gantt, "```", ""].join("\n"),
	)
}

main().catch((e) => {
	console.error(e)
	process.exit(1)
})

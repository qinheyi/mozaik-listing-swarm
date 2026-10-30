/**
 * The shared Mozaik runtime + the typed shared state every participant reads/writes.
 */
import { defineRuntime, RuntimeState, SemanticEvent, SituationSpecification, type SituationContext } from "@mozaik-ai/core"
import type { Product } from "./kb"

export type Section = "research" | "pricing" | "seo" | "copy"
export type Verdict = { round: number; verdict: "APPROVE" | "REVISE"; issues: string[]; notes?: string; by: string }

export type ListingBoard = {
	sku: string
	product: Product
	research?: any
	pricing?: any
	seo?: any
	copy?: any
	copyRound: number
	copyInFlight: boolean
	reviews: Verdict[]
	approved: boolean
	published: boolean
	sectionReadyAt: Partial<Record<Section, number>>
}

export type LoopTrace = {
	loopId: string
	agent: string
	sku: string
	task: string
	start: number
	end?: number
	inferences: number
	toolCalls: string[]
}

/** Shared blackboard: one board per SKU, plus telemetry the observers fill in. */
export class StudioState extends RuntimeState {
	boards = new Map<string, ListingBoard>()
	loops = new Map<string, LoopTrace>()
	activeLoops = 0
	peakActiveLoops = 0
	activeInferences = 0
	peakActiveInferences = 0
	eventCount = 0
	startedAt = Date.now()
}

export const { initializeRuntime, resolveRuntime, join, leave, sendMessage, sendEvent, runLoop } = defineRuntime<StudioState>()

export const state = () => resolveRuntime().state

// ---- custom semantic events (the team's protocol) -------------------------------------------
export const EV = {
	brief: "brief.submitted",
	sectionReady: "section.ready",
	verdict: "review.verdict",
	published: "listing.published",
	allDone: "batch.completed",
} as const

export type BriefPayload = { sku: string }
export type SectionReadyPayload = { sku: string; section: Section; round?: number }
export type VerdictPayload = { sku: string } & Verdict
export type PublishedPayload = { sku: string; file: string; warnings: string[] }

export const emit = <T>(type: string, producerId: string, payload: T) =>
	sendEvent(SemanticEvent.create(type, producerId, payload), producerId)

// ---- reusable situation specifications -------------------------------------------------------
export class EventIs extends SituationSpecification {
	constructor(
		private readonly type: string,
		private readonly where: (payload: any) => boolean = () => true,
	) {
		super()
	}
	isSatisfiedBy({ event }: SituationContext): boolean {
		return event.type === this.type && this.where(event.payload)
	}
}

export class FromOthers extends SituationSpecification {
	isSatisfiedBy({ event, participant }: SituationContext): boolean {
		return event.producerId !== participant.getId()
	}
}

export class AnyEvent extends SituationSpecification {
	isSatisfiedBy(): boolean {
		return true
	}
}

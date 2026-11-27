import { t } from "../state/i18n-bridge.ts";
import { sanitizeTerminalText } from "../tool/sanitize.ts";
export interface RunRow {
	id: string;
	name: string;
	agent?: string;
	model?: string;
	startedAt: number;
	phase: { kind: string; label?: string; since?: number };
	cancel?: string;
}
export interface Probe {
	claim?: { by: string; ids: string[] };
	rows?: { version: 1; rows: RunRow[] };
}
export type Query = (probe: Probe) => void;
export function liveRows(query?: Query) {
	const p: Probe = {};
	try {
		query?.(p);
	} catch {
		return undefined;
	}
	if (p.rows?.version !== 1 || !Array.isArray(p.rows.rows)) return undefined;
	return new Map(
		p.rows.rows
			.filter(
				(r) =>
					r &&
					typeof r.id === "string" &&
					typeof r.name === "string" &&
					typeof r.phase?.kind === "string" &&
					Number.isFinite(r.startedAt),
			)
			.map((r) => [r.id, r]),
	);
}
export function shortModel(model: string) {
	const base = model.split("/").at(-1) ?? model;
	return (
		base
			.split(/[-_:]/)
			.filter(
				(x) => x && !/^(?:claude|gpt|openai|anthropic|\d[\d.]*)$/i.test(x),
			)
			.join("-") || base
	);
}
const words: Record<string, string> = {
	"tool.thread_wait": "waiting for thread",
	"active.reviewer": "reviewing",
	"kind.active": "running",
};
export function runLine(row: RunRow, now: number) {
	const { kind, label, since } = row.phase;
	const keys = [
		label && `tool.${label}`,
		kind === "active" && row.agent && `active.${row.agent}`,
		`kind.${kind}`,
	];
	const word =
		keys
			.filter(Boolean)
			.map((k) => t(`run.${k}`, words[String(k)] ?? ""))
			.find(Boolean) || kind;
	const s = Math.max(
		0,
		Math.floor(
			(now - (Number.isFinite(since) ? since! : row.startedAt)) / 1000,
		),
	);
	const time =
		s < 60
			? `${s}s`
			: s < 3600
				? `${Math.floor(s / 60)}m`
				: `${Math.floor(s / 3600)}h${String(Math.floor(s / 60) % 60).padStart(2, "0")}m`;
	return sanitizeTerminalText(
		[row.name, row.model && shortModel(row.model), `${word} ${time}`]
			.filter(Boolean)
			.join(" · "),
	);
}

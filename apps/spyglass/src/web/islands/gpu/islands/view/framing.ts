/**
 * What a chart id frames: the circle of the chart the camera flies to for
 * an island, a ring or a module (camera.ts `frameOrbit`). Pure, no GPU.
 */
import type { Chart, Point } from "../../../data/chart";
import type { Banks } from "../sea/banks";

/** A circle of the chart: its centre and radius, chart units. */
export interface Framed {
	centre: Point;
	radius: number;
}

/** The radius a module is framed by, chart units: the file and the street round it. */
export const MODULE_FRAME_RADIUS = 12;

/**
 * The circle a chart id frames, by the same ids `select` takes: an island
 * (its place and size), a ring (the box round its members, out to their
 * sizes), or a module (its place, `MODULE_FRAME_RADIUS` round it). Null
 * when the id names none of them.
 */
export function framedOf(
	chart: Chart,
	banks: Banks,
	id: string
): Framed | null {
	const island = chart.islands.find((candidate) => candidate.id === id);
	if (island) {
		return { centre: island.at, radius: island.size };
	}
	const bank = banks.banks.find((candidate) => candidate.id === id);
	const members = (bank?.islands ?? []).flatMap((index) => {
		const member = chart.islands[index];
		return member ? [member] : [];
	});
	if (members.length > 0) {
		const minX = Math.min(...members.map((m) => m.at[0] - m.size));
		const maxX = Math.max(...members.map((m) => m.at[0] + m.size));
		const minY = Math.min(...members.map((m) => m.at[1] - m.size));
		const maxY = Math.max(...members.map((m) => m.at[1] + m.size));
		return {
			centre: [(minX + maxX) / 2, (minY + maxY) / 2],
			radius: Math.hypot(maxX - minX, maxY - minY) / 2,
		};
	}
	const module = chart.modules.find((candidate) => candidate.id === id);
	return module ? { centre: module.at, radius: MODULE_FRAME_RADIUS } : null;
}

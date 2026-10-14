/**
 * Presentation model: labels and numbers only. Nothing here names a glyph,
 * a color, or a column width; those belong to the renderer and its context.
 */
export interface ReportView {
  sections: SectionView[];
  title: string;
}

/** A titled section indents its body; a headless one renders flush. */
export interface SectionView {
  blocks: BlockView[];
  title?: string;
}

/**
 * Tone carries no good/bad meaning. `caution` and `blocked` are the only
 * tones a renderer may color; every toned line also carries a glyph or word.
 */
export type Tone = "neutral" | "emphasis" | "caution" | "blocked" | "anchored";

export interface LabelValueRow {
  label: string;
  value: string;
}

/** Part of a whole. `numerator of denominator` shows when both are given. */
export interface RatioItem {
  denominator?: number;
  label: string;
  numerator?: number;
  /** 0..1 */
  value: number;
}

export interface FunnelStage {
  label: string;
  value: number;
}

/** One slice of a whole that sums to 1 across the block. */
export interface DistributionItem {
  detail?: string;
  label: string;
  /** 0..1 */
  share: number;
}

export interface RankedItem {
  detail?: string[];
  label: string;
  value: number;
}

export interface GateCheck {
  label: string;
  passed: boolean;
}

export type BlockView =
  | { kind: "text"; lines: string[] }
  | { kind: "labelValue"; rows: LabelValueRow[] }
  | { kind: "ratio"; items: RatioItem[] }
  | { kind: "funnel"; stages: FunnelStage[] }
  | { kind: "distribution"; items: DistributionItem[] }
  | { kind: "rankedList"; items: RankedItem[]; overflow?: number }
  | { kind: "list"; items: string[]; overflow?: number }
  | {
      kind: "signal";
      title: string;
      tone: Tone;
      summary?: string;
      evidence?: string[];
    }
  | { kind: "gate"; title: string; checks: GateCheck[]; result: string }
  | { kind: "edge"; from: string; to: string; label?: string }
  /** Teaching aside: what a concept means and why it matters. */
  | { kind: "note"; title: string; lines: string[] };

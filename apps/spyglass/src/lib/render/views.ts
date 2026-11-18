export interface ReportView {
  sections: SectionView[];
  title: string;
}

export interface SectionView {
  blocks: BlockView[];
  title?: string;
}

export type Tone = "neutral" | "emphasis" | "caution" | "blocked" | "anchored";

export interface LabelValueRow {
  label: string;
  value: string;
}

export interface RatioItem {
  denominator?: number;
  label: string;
  numerator?: number;
  value: number;
}

export interface FunnelStage {
  label: string;
  value: number;
}

export interface DistributionItem {
  detail?: string;
  label: string;
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
  | { kind: "note"; title: string; lines: string[] };

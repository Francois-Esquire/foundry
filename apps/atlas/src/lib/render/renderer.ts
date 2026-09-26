import type { BlockView, ReportView, SectionView } from "./views";

export interface Renderer {
  block(view: BlockView): string[];
  report(view: ReportView): string;
  section(view: SectionView): string[];
}

/**
 * The record of a capture and the page that shows it. A run replaces the flows
 * it retook and keeps every other flow as it was last captured, so a flow that
 * costs money to retake stays in the gallery until someone retakes it.
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Call, Problem, Shot } from "./context";

interface FlowRecord {
  capturedAt: string;
  name: string;
}
export interface Manifest {
  calls: Call[];
  flows: FlowRecord[];
  problems: Problem[];
  shots: Shot[];
}
/** What one run adds: the flows it retook, in the order of the gallery. */
interface Run extends Pick<Manifest, "calls" | "problems" | "shots"> {
  at: string;
  /** Every flow the gallery can hold, in order. */
  order: readonly string[];
  retaken: readonly string[];
}

const EMPTY: Manifest = { calls: [], flows: [], problems: [], shots: [] };

/** The last capture's record, or an empty one when there is none to build on. */
export const readManifest = async (out: string): Promise<Manifest> => {
  const text = await readFile(path.join(out, "manifest.json"), "utf8").catch(
    () => undefined
  );
  const parsed: Partial<Manifest> = text ? JSON.parse(text) : {};
  return Array.isArray(parsed.flows) ? { ...EMPTY, ...parsed } : EMPTY;
};

export const mergeManifest = (previous: Manifest, run: Run): Manifest => {
  const kept = <Item extends { flow: string }>(items: readonly Item[]) =>
    items.filter((item) => !run.retaken.includes(item.flow));
  const flows = [
    ...previous.flows.filter((flow) => !run.retaken.includes(flow.name)),
    ...run.retaken.map((name) => ({ capturedAt: run.at, name })),
  ].filter((flow) => run.order.includes(flow.name));
  flows.sort((a, b) => run.order.indexOf(a.name) - run.order.indexOf(b.name));
  const held = new Set(flows.map((flow) => flow.name));
  // In the order of the gallery. The sort is stable, so steps keep their order.
  const inGallery = <Item extends { flow: string }>(items: Item[]) =>
    items
      .filter((item) => held.has(item.flow))
      .sort((a, b) => run.order.indexOf(a.flow) - run.order.indexOf(b.flow));
  return {
    calls: inGallery([...kept(previous.calls), ...run.calls]),
    flows,
    problems: inGallery([...kept(previous.problems), ...run.problems]),
    shots: inGallery([...kept(previous.shots), ...run.shots]),
  };
};

const htmlText = (text: string) =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const STYLE = `
body{margin:0;padding:32px;background:#f7f8f7;color:#0b0c0d;font:300 15px/1.5 system-ui,sans-serif}
h1{margin:0 0 8px;font-weight:200;font-size:40px;letter-spacing:.01em}
h2{margin:0;font-weight:300;font-size:24px}
p{margin:0 0 8px;max-width:62ch}
section{margin-top:40px;padding-top:16px;border-top:1px solid #0b0c0d}
.shots{display:grid;grid-template-columns:repeat(auto-fill,minmax(420px,1fr));gap:24px;margin-top:16px}
figure{margin:0;border:1px solid rgb(11 12 13 / 26%)}
img{display:block;width:100%;height:auto;border-bottom:1px solid rgb(11 12 13 / 26%)}
figcaption{padding:12px}
.label{font-size:11px;letter-spacing:.08em;text-transform:uppercase}
.made{color:#1f3bd0}
table{border-collapse:collapse;margin-top:8px}
th,td{padding:4px 16px 4px 0;border-bottom:1px solid rgb(11 12 13 / 26%);text-align:left;font-weight:300}
th{font-size:11px;letter-spacing:.08em;text-transform:uppercase}
@media (max-width:520px){body{padding:16px}.shots{grid-template-columns:1fr}}
`;

const figure = (shot: Shot) => {
  const made = shot.source
    ? `<br><span class="label made">${htmlText(shot.source)}</span> ${htmlText(shot.model ?? "")}${shot.latencyMs === undefined ? "" : `, ${shot.latencyMs} ms`}`
    : "";
  return `<figure><a href="${htmlText(shot.file)}"><img loading="lazy" src="${htmlText(shot.file)}" alt="${htmlText(shot.caption)}"></a><figcaption><span class="label">${htmlText(shot.step)}, ${shot.width} wide, ${shot.theme} tape</span><br>${htmlText(shot.caption)}${made}</figcaption></figure>`;
};

const section = (manifest: Manifest, flow: FlowRecord) => {
  const problems = manifest.problems
    .filter((problem) => problem.flow === flow.name)
    .map((problem) => `<p>Problem: ${htmlText(problem.text)}</p>`)
    .join("");
  const shots = manifest.shots
    .filter((shot) => shot.flow === flow.name)
    .map(figure)
    .join("");
  return `<section><h2>${htmlText(flow.name)}</h2><p class="label">Captured ${htmlText(flow.capturedAt)}</p>${problems}<div class="shots">${shots}</div></section>`;
};

const callsTable = (calls: readonly Call[]) =>
  calls.length === 0
    ? "<p>No flow in this gallery called a model. Model output shown here is recorded or built by rule.</p>"
    : `<p>Live model calls behind the flows in this gallery: ${calls.length}.</p><table><tr><th>Flow</th><th>Model</th><th>Asked for</th><th>Took</th><th>Outcome</th><th>When</th></tr>${calls
        .map(
          (call) =>
            `<tr><td>${htmlText(call.flow)}</td><td>${htmlText(call.model)}</td><td>${htmlText(call.request)}</td><td>${call.latencyMs} ms</td><td>${htmlText(call.outcome)}</td><td>${htmlText(call.at)}</td></tr>`
        )
        .join("")}</table>`;

const page = (manifest: Manifest) => {
  const times = manifest.flows.map((flow) => flow.capturedAt).sort();
  const when =
    times.length === 0
      ? "Nothing is captured yet."
      : `${manifest.flows.length} flows and ${manifest.shots.length} screenshots, captured between ${htmlText(times[0] ?? "")} and ${htmlText(times.at(-1) ?? "")}. Each flow says when it was last taken.`;
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Typography user flows</title><style>${STYLE}</style><h1>Typography user flows</h1><p>${when}</p><p>A shot of model output is marked live, recorded or built by rule. The Devanagari work is a defined subset of 15 characters, 3 forms and 9 test words, not support for the script.</p>${callsTable(manifest.calls)}${manifest.flows.map((flow) => section(manifest, flow)).join("")}</html>`;
};

/** Writes the record and the page that shows it. */
export const writeGallery = async (out: string, manifest: Manifest) => {
  await writeFile(
    path.join(out, "manifest.json"),
    JSON.stringify(manifest, null, 2)
  );
  await writeFile(path.join(out, "index.html"), page(manifest));
};

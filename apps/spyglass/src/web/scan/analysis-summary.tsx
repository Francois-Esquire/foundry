import type {
  DatasetAnalysis,
  RepositoryAcquisitionLimitation,
} from "../../lib/dataset-analysis";

// What a browser scan could and could not see, read from the dataset's own
// saved analysis metadata (`reader.analysis()`), never inferred: the source
// revision, what was read and omitted, and each gap a native scan would not
// have. Only a dataset with analysis metadata has one; a native or saved
// dataset never reaches here.

const LIMITATIONS: Record<RepositoryAcquisitionLimitation, string> = {
  "dependencies-not-installed":
    "No dependency was installed, so types from packages outside the repository are unknown.",
  "history-not-fetched":
    "Git history was not fetched, so change, churn and co-change readings are absent.",
  "integrity-is-listing-consistency":
    "Each file matched GitHub's listing (size and Git blob SHA-1); GitHub's TLS is the only trust anchor.",
  "named-ref-resolved-by-github":
    "GitHub resolved the ref name; when a branch and a tag share it, GitHub chose.",
  "outside-scope-not-read":
    "Files outside the scope (such as a root lockfile or tsconfig) were not read.",
  "public-repositories-only": "Only public repositories, without credentials.",
};

const SHOWN = 8;

function Listed({ items, label }: { items: readonly string[]; label: string }) {
  if (items.length === 0) {
    return null;
  }
  const more = items.length - SHOWN;
  return (
    <li>
      {label}: {items.length}
      <ul className="spyglass-scan-paths">
        {items.slice(0, SHOWN).map((item) => (
          <li key={item}>
            <code>{item}</code>
          </li>
        ))}
        {more > 0 ? <li>and {more} more</li> : null}
      </ul>
    </li>
  );
}

function Source({ analysis }: { analysis: DatasetAnalysis }) {
  const { origin } = analysis;
  if (origin.kind !== "github-repository") {
    return (
      <p>
        A file map placed under <code>{origin.root}</code>.
      </p>
    );
  }
  const { acquisition, repository } = origin;
  const slug = `${repository.owner}/${repository.repo}`;
  const commit = repository.resolvedCommit;
  const omitted = acquisition.omissions;
  return (
    <>
      <dl className="spyglass-scan-facts">
        <dt>Repository</dt>
        <dd>
          <a
            href={`https://github.com/${slug}/tree/${commit}${repository.scope === null ? "" : `/${repository.scope}`}`}
            rel="noreferrer"
            target="_blank"
          >
            github.com/{slug}
          </a>
        </dd>
        <dt>Ref</dt>
        <dd>
          {repository.requestedRef ??
            `default branch (${repository.defaultBranch})`}
        </dd>
        <dt>Commit</dt>
        <dd>
          <code>{commit}</code>
        </dd>
        {repository.scope === null ? null : (
          <>
            <dt>Scope</dt>
            <dd>
              <code>{repository.scope}</code>
            </dd>
          </>
        )}
        <dt>Read</dt>
        <dd>
          {acquisition.read.files} files, {acquisition.read.bytes} bytes
        </dd>
      </dl>
      <h3>Not read</h3>
      <ul>
        <li>
          {omitted.notAnalysisInput} files outside the analysis inputs (not
          TypeScript, JavaScript, JSON or workspace manifests)
        </li>
        <Listed items={omitted.symlinks} label="Symbolic links, not followed" />
        <Listed items={omitted.submodules} label="Submodules, not fetched" />
        <Listed
          items={omitted.nodeModules}
          label="Committed node_modules files"
        />
        <Listed items={omitted.binary} label="Binary files" />
        <Listed items={omitted.notUtf8} label="Files that are not UTF-8" />
        <Listed
          items={omitted.tooLarge.map(({ path, size }) => `${path} (${size})`)}
          label={`Files over ${acquisition.limits.maxFileBytes} bytes`}
        />
      </ul>
      <h3>Limits of this scan</h3>
      <ul>
        {acquisition.limitations.map((limitation) => (
          <li key={limitation}>{LIMITATIONS[limitation]}</li>
        ))}
      </ul>
    </>
  );
}

/** The analysis metadata of a browser scan, in full. */
export function AnalysisSummary({ analysis }: { analysis: DatasetAnalysis }) {
  const { capabilities, provenance } = analysis;
  const { configuration, history, moduleGraph, types } = capabilities;
  const unresolved = moduleGraph.unresolved.map(
    ({ from, specifier }) => `${specifier} from ${from}`
  );
  return (
    <div className="spyglass-scan-summary">
      <Source analysis={analysis} />
      <h3>Gaps in the readings</h3>
      <ul>
        <li>History unavailable: {history.detail}</li>
        <li>
          Island internals were not assembled, so an island's file-level
          evidence is unavailable.
        </li>
        <Listed
          items={types.unresolvedPackages}
          label="Packages whose types could not be resolved from the repository"
        />
        <Listed items={types.diagnostics} label="Type diagnostics" />
        <Listed
          items={unresolved}
          label="Imports the graph could not resolve"
        />
        <Listed
          items={configuration.configModules}
          label="Configuration modules, read as data and never run"
        />
        {configuration.diagnostics.length > 0 ? (
          <Listed
            items={configuration.diagnostics}
            label="tsconfig diagnostics"
          />
        ) : null}
        <li>
          tsconfig:{" "}
          {configuration.tsconfig === null ? (
            "none named; workspace aliases only"
          ) : (
            <code>{configuration.tsconfig}</code>
          )}
        </li>
        {provenance.inputsFingerprint === "unrecorded" ? (
          <li>
            No inputs fingerprint, so currency checks report it unrecorded.
          </li>
        ) : null}
      </ul>
    </div>
  );
}

/** One line of what the scan lacks, for the result's collapsed summary. */
export function gapLine(analysis: DatasetAnalysis): string {
  const { types, moduleGraph } = analysis.capabilities;
  const parts = ["no history", "no internals"];
  if (types.unresolvedPackages.length > 0) {
    parts.push(
      `${types.unresolvedPackages.length} packages without resolved types`
    );
  }
  if (moduleGraph.unresolved.length > 0) {
    parts.push(`${moduleGraph.unresolved.length} unresolved imports`);
  }
  return parts.join(" · ");
}

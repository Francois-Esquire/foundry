import { useCallback } from "react";
import { type DomainRef, domainExtent } from "../domain-extent";
import type { AtlasData } from "../types";
import { domainReading } from "./nesting-domain-text";

/**
 * The chosen domain in Place, under the selection's heading, which it does
 * not replace: its name, what it covers and what its labels say, and a
 * button that stops drawing it and hands focus on (`onCleared`), since the
 * button goes with the block.
 */
export function DomainPlace({
  data,
  domain,
  onCleared,
  onDomain,
}: {
  data: AtlasData;
  domain: DomainRef | null;
  onCleared: () => void;
  onDomain: (domain: DomainRef | null) => void;
}) {
  const clear = useCallback(() => {
    onDomain(null);
    onCleared();
  }, [onCleared, onDomain]);
  const extent = domain ? domainExtent(data, domain) : null;
  const frame = data.frames.find((item) => item.id === extent?.frame);
  if (!(extent && frame)) {
    return null;
  }
  return (
    <section aria-label="Chosen domain" className="atlas-place-domain">
      <div className="atlas-place-heading">
        <h3>Domain {extent.name}</h3>
        <button className="atlas-place-close" onClick={clear} type="button">
          Clear domain
        </button>
      </div>
      {domainReading(frame.readings, extent).map((line) => (
        <p className="atlas-place-note" key={line}>
          {line}
        </p>
      ))}
    </section>
  );
}

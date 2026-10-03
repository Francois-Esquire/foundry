export function MapKey({
  streams,
  volcanic,
}: {
  streams: boolean;
  volcanic: boolean;
}) {
  return (
    <details className="atlas-map-key">
      <summary>Map key</summary>
      <dl>
        <div>
          <dt>
            <svg aria-hidden="true" viewBox="0 0 44 24">
              <path
                d="M5 20 Q12 16 20 4 Q28 12 39 20Z"
                fill="#cbb98e"
                stroke="#78664e"
              />
              <path d="M20 4 L24 15 L39 20 L20 11 L13 16Z" fill="#887959" />
            </svg>
            Summit
          </dt>
          <dd>
            Shared commons, composition junction, or dependency hub. Size
            follows incoming imports.
          </dd>
        </div>
        <div>
          <dt>
            <svg aria-hidden="true" viewBox="0 0 44 24">
              <path
                d="M5 21 L17 7 Q22 11 27 7 L39 21Z"
                fill="#c5ae83"
                stroke="#78664e"
              />
              <ellipse
                cx="22"
                cy="7"
                fill="#a6503e"
                rx="5"
                ry="2.5"
                stroke="#61503e"
              />
            </svg>
            Recorded change{!volcanic && " · off"}
          </dt>
          <dd>
            Frequent recorded changes form a crater; on a structural summit, a
            volcano. Counts and the history window are in Place.
          </dd>
        </div>
        <div>
          <dt>
            <svg aria-hidden="true" viewBox="0 0 44 24">
              <path
                d="M4 7 C12 4 12 15 23 14 S30 8 40 10 M10 22 C16 21 14 15 23 14"
                fill="none"
                stroke="#537d78"
                strokeLinecap="round"
                strokeWidth="1.7"
              />
            </svg>
            District stream{!streams && " · off"}
          </dt>
          <dd>
            Supplier to consumer. Shared trunks add module edges. Direction and
            symbols are in Place.
          </dd>
        </div>
        <div>
          <dt>
            <svg aria-hidden="true" viewBox="0 0 44 24">
              <path
                d="M4 17 Q12 19 20 17 M12 16 Q12 11 11 8 M8 16 L6 12 M16 16 L18 11 M26 10 Q32 12 39 10 M32 9 L32 3 M28 9 L27 6 M36 9 L38 5"
                fill="none"
                stroke="#697855"
                strokeLinecap="round"
              />
            </svg>
            Unresolved marsh
          </dt>
          <dd>
            Belonging is undecided. Dotted drains lead toward recorded
            candidates, not assigned owners.
          </dd>
        </div>
      </dl>
      <p>
        Roles, never quality. Land height means file concentration. Summit and
        crater symbols carry separate evidence. Omitted routes are listed in
        Place.
      </p>
    </details>
  );
}

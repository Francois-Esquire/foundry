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
        Neighborhoods share levels based on average incoming imports per file.
        Rounded slopes join their levels; ungrouped files stay on low ground.
        Commons and composition junctions are identified in Place. Height is not
        a quality score.
        {volcanic
          ? " Recorded Git change counts and dates are in Place."
          : " Recorded change is off."}{" "}
        Roles, measured consumers and omitted routes are in Place.
      </p>
    </details>
  );
}

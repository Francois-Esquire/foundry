import "./section-head.css";

interface SectionHeadProps {
  readonly heading: string;
  /** Lets the section point at its heading with aria-labelledby. */
  readonly id?: string;
  /** One sentence that says what the section is for. */
  readonly lede?: string;
  readonly level?: 2 | 3;
}

/** A light heading with a one-sentence lede set beside it. */
export function SectionHead({
  heading,
  id,
  lede,
  level = 2,
}: SectionHeadProps) {
  const Heading = level === 2 ? "h2" : "h3";
  return (
    <div className="ty-section-head">
      <Heading className="ty-heading" id={id}>
        {heading}
      </Heading>
      {lede ? <p className="ty-lede">{lede}</p> : null}
    </div>
  );
}

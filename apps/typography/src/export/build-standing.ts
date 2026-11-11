/** What is said beside a build button while problems stand in the way of the build. */
export const resolveFirst = (problems: number) =>
  `Resolve the ${problems === 1 ? "problem" : `${problems} problems`} above to build.`;

/**
 * The builder the application hands out. A build that is given its modified
 * time gives the same bytes every time, so every font the application builds
 * carries the application's clock time: an export, a working build of Proof,
 * a variable font and the build a script extension is verified in. No caller
 * has to remember to ask.
 */
import type { FontBuilder } from "~/packaging/building";

/**
 * A blank font is left alone: it carries no clock time, and the project
 * knows it by the digest of its bytes.
 */
export const stamping = (
  builder: FontBuilder,
  clock: () => Date
): FontBuilder => ({
  blankFont: (request) => builder.blankFont(request),
  build: (request) =>
    builder.build({
      ...request,
      modifiedAt: request.modifiedAt ?? clock().toISOString(),
    }),
  buildVariable: (request) =>
    builder.buildVariable({
      ...request,
      modifiedAt: request.modifiedAt ?? clock().toISOString(),
    }),
  describeLayout: (font, faceIndex) => builder.describeLayout(font, faceIndex),
  validate: (font) => builder.validate(font),
});

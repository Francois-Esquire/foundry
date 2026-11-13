# A project saved in format 2

A project as the application wrote it on 11 November 2026, at commit
`30ba1106`, before a revision named what it accepted in one field and before
a candidate's standing was read from the history.

`directory/` is the whole project directory: `records.json` and `blobs/`, as
`@foundry/artifacts` wrote them. It holds five artifacts: Lato Regular, the
storefront photograph, the project, and the model output of two recorded runs.

`project.json` is the project file from that directory, byte for byte, so it
can be read without opening the store. It holds:

- two held runs of the Devanagari subset for Lato Regular, each with its 19
  changes. The second was accepted. The first was not, and can never be: its
  glyph names are in the face already.
- two revisions. The first names the run it accepted in `acceptsRun`. The
  second names the candidate it accepted in `accepts`.
- six candidates, each with a stored `status` and a `verdict`: one accepted,
  five proposed.
- one photograph, with its `artifactId` written beside its digest.

`inspect.json` is what the same code answered to `inspect` for this project.
It lists the first run as waiting, which is the defect described above.

It was made with the command line: import `Lato-Regular.ttf` and
`storefront-needed-things.jpg`, generate the script extension from the
recorded Devanagari run twice, accept the second run, generate from the
recorded Latin holdout (`--output vector-model`), accept its first candidate.

A test that reopens an old project copies `directory/` somewhere temporary and
opens the copy. Never open the fixture itself: saving rewrites a project in
place. Do not regenerate it with newer code: its purpose is to stay as old code
wrote it.

To check that nothing here has changed since it was added, in commit
`d5b764b0`, run this from the repository root. It prints this README and no
other file:

    git diff --stat d5b764b0 HEAD -- apps/typography/test/fixtures/projects/format-2

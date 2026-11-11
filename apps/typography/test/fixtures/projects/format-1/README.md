# A project saved in format 1

A project as the application wrote it on 11 November 2026, at commit
`6d123720`, before verdicts and waiting runs moved into the project.

`directory/` is the whole project directory: `records.json` and `blobs/`, as
`@foundry/artifacts` wrote them. It holds five artifacts: Lato Regular, the
storefront photograph, the project, and the model output of two recorded runs.
The Devanagari one is a waiting run, so its artifact also holds the
`change-set.json` that format 1 kept there.

`project.json` is the project file from that directory, byte for byte, so it
can be read without opening the store. It holds Lato with one accepted
candidate, five proposed candidates, a top-level `verdicts` record with all
six verdicts, one waiting run in a top-level `waitingRuns` list, and one
photograph.

It was made with the command line: import `Lato-Regular.ttf` and
`storefront-needed-things.jpg`, generate the script extension from the recorded
Devanagari run, generate from the recorded Latin holdout (vector model), accept
its first candidate.

A test that reopens an old project copies `directory/` somewhere temporary and
opens the copy. Never open the fixture itself: saving rewrites a project in
place. Do not regenerate it with newer code: its purpose is to stay as old code
wrote it.

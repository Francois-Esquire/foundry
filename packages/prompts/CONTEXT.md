# Prompts

The prompts package reads, checks, and writes prompts meant for a CLI
harness. These are the terms its interface, its diagnostics, and its tests
use.

## Language

### What is written

**Prompt**:
Text an author wrote for a harness, the dialect it was written in,
everything it references, and its diagnostics as of now against what
exists.
_Avoid_: instruction, query, input, message (that is a surface)

**Dialect**:
The grammar one harness reads a prompt with. Named by the harness id the
rest of the repository routes on: `claude-code`, `codex`, `pi`. A value;
it reads no text.
_Avoid_: syntax, language, flavor, mode

**Notation**:
One construct a dialect recognizes: a sigil, what may follow it, and the
reference it stands for. A dialect is an ordered list of notations; the
first that matches wins.
_Avoid_: rule, pattern, token type, mini syntax

**Sigil**:
The leading character(s) that open a notation, such as `/`, `@`, `$`,
`/skill:`, or `` !` ``.
_Avoid_: prefix, trigger, marker

**Surface**:
Where a prompt is read. A **message** is sent to the harness as the user's
turn. A **template** is a file the harness expands first: a `SKILL.md`, a
command file, a custom prompt, a prompt template. Some notation is only
substituted inside a template.
_Avoid_: context, mode, scope

### What is meant

**Prompt reference**:
What a notation points at, independent of how it was written. One
vocabulary across every dialect, so a consumer reasons about "a skill
reference" without knowing whether it was `/name`, `$name`, or
`/skill:name`.
_Avoid_: mention (that is one notation), link, symbol

**Prompt reference kind**:
The sort of thing referred to. **Skill**: a named capability the harness
loads. **Agent**: a subagent. **File**: a path in the workspace.
**Command**: an action the harness performs itself. **Template**: a saved
prompt the harness expands. **Argument**: a placeholder filled from the
invocation that expanded the template. **Variable**: a value the harness
provides when it expands a template. **Shell**: a command run in the shell.
_Avoid_: type, category, entity

**Name**:
The identifier a reference resolves by, namespace included
(`plugin:skill`). A file's name is its path.
_Avoid_: id, key, slug

**Origin**:
How a reference got into a prompt: **text** when the author wrote the
notation, **symbol** when a value was interpolated.
_Avoid_: source (that is what exists), provenance

**Referenceable**:
A value that knows the reference it is, through the reference protocol, a
well-known symbol. A virtual skill, a code-declared agent. Interpolated,
it is written in the dialect's notation; statically, the type checker
resolves it. The generic reference vocabulary, this included, is defined in
`@foundry/core/agents`; the prompt-only kinds are defined here.
_Avoid_: macro, handle, token

### What exists

**Prompts**:
One flat object a host builds once: a tag per dialect, and what exists as
layers. `prompts` is the one that comes out of the box.
_Avoid_: catalog, registry, syntax, manager, context

**Tag**:
Authors a prompt in one dialect against a prompts: `prompts.claude`. A
template tag, and also callable with plain text.
_Avoid_: builder, factory, template

**Catalog**:
The agents package's own prompt source: what its registries know.
_Avoid_: catalog for the whole set (that is prompts)

**Prompt source**:
One layer of what exists: a skill registry, an agent catalog, a file
checker. It answers whether it covers a kind and whether it has a name. A
reference resolves when any layer has it; a kind is validated when any
layer covers it.
_Avoid_: provider, adapter (that is its role, not its name here), backend,
catalog alone (the models package has a model catalog, Marbles an authoring
catalog)

**Built-ins**:
The names a harness knows without any layer: its own commands, the
variables it substitutes. A dialect's own layer.
_Avoid_: defaults, known names, reserved words

**Strict**:
A prompts that throws from its tags instead of returning a prompt with
errors.
_Avoid_: validation mode, fail-fast, assert

### What comes out

**Parser**:
Turns text into tokens for one dialect, and nothing else.
_Avoid_: lexer, scanner (internal), tokenizer

**Token**:
One scanned piece of the prompt with its span: a reference, an escape,
plain text, or, when a template is read statically, a hole where an
interpolation sits. Tokens cover the text contiguously. A highlighter needs
only tokens.
_Avoid_: lexeme, node, segment

**Hole**:
Where an interpolation sits when a template is read statically. No
notation spans one; a tool reports it as dynamic, never unknown.
_Avoid_: placeholder (that is an argument), slot, expression

**Span**:
A half-open character range `[start, end)` into the prompt text.
_Avoid_: range, location, position

**Diagnostic**:
One finding about a prompt: a code, a severity, a span, and the reference
it concerns. **Unresolved reference**: no layer and no built-in has the
name. **Foreign notation**: a skill or agent the host has, written with
another dialect's sigil. **Template-only**: notation that is only
substituted in a template, found in a message. **Consumed by harness**: the
message is acted on by the harness and never reaches the model.
**Unsupported reference**: an interpolated reference the dialect cannot
write, so it was written as plain text.
_Avoid_: error (that is a severity), warning, issue, lint

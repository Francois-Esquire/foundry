Detection
- Introspect project
- Graph Project code and dependencies
- Gather documentation for LLMs based on deps (Context7)
- Create special conventions based on code
- Find delta to ideal project structure

Analysis (constantly evolving)
- Find usage patterns from samples, figure out how user is making
- Normalize project to follow best practices, correct some user patterns
- Shape project to follow production workflows (best for our system)

Things we can use this for
- Gather prelim context for LLM operations (atomic)
- Architect solutions and creating a clear path forward (planning)
- Create Staff Engineer agent for answering questions (augment equivalent)

Systems and Plugins to use
- vite-plugin-inspect (see how files transform)
- storybook (ux/ui)

What this solves for
- Common changes can break many other files without context
- Needed changes will need to update dependents
- Tieing the code to higher order principles and goals
- Analyzing what work needs to be done on a project to reach final goal
- intelligently creating parallel pathways and helping order steps to reach goals
- Quickly setting up projects or transforming existing projects to perform better (from an LLM building perspective)

Initial Usage steps (existing project or newly built)
- Initial run will detect project and make sure its JS/TS and uses git
  - If no git, recommend we install if files exist
  - If not JS/TS, let them know we cannot help unless they opt in to experimental self-enhancing AI setup
  - If new project or empty folder, go to step three
- Check frameworks, code, deps, etc - run other detectors
  - Detect for all things including deployment, etc
  - Detect for multiple apps (if monorepo)
- Initial setup will get acquainted with project
  - If new project, start with new project steps
    - Get base info on what they are trying to build, name of project - get full scope in brief to correctly design project based on requirements
    - Scaffold project
  - If its an existing project, gather goals on high level
    - Infer project goals and then ask for clarity
    - Understand what services and infra is in place
  - Ask user about conventions, or apply ours- certain concepts like presentational vs data components is required
  - Ask if project is in production, if so, handle in safe mode
- Normalize project, correct config, flag security concerns, etc
  - For each detector, add fixes and recommendations
- Index project and graph it
- Gather source material and LLM docs (context7)
- Build custom project agents


Future features
- Detect and operate with other languages, types and support different frameworks
- optimize configurations based on your code (like resolvers set to ts for ts projects, etc)
- Use LLM services to build custom extensions for foundry

Augmentations
- Gather project context and file context from single mcp call (from codebase), brief and detailed
- get dependency graph and measure impact of changes, figure out best path forward on complexity scale
- Can be called from code ide or llm. Set guardrails for llm calls, add what to do and what not to do.
- Refine focus of task

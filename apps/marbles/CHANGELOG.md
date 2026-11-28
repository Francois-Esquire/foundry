# Changelog

## [0.0.5](https://github.com/Francois-Esquire/foundry/compare/marbles-v0.0.4...marbles-v0.0.5) (2026-11-28)


### ⚠ BREAKING CHANGES

* portable authoring, cloud store seams, and stateless execution primitives ([#156](https://github.com/Francois-Esquire/foundry/issues/156))
* **agents:** remove unused subsystems ahead of the harness rewrite ([#154](https://github.com/Francois-Esquire/foundry/issues/154))
* **sandbox:** harden container lifecycle, ownership proof, and collapse wrappers ([#153](https://github.com/Francois-Esquire/foundry/issues/153))
* **models:** drop unused subsystems and Airplane Mode ([#152](https://github.com/Francois-Esquire/foundry/issues/152))
* **marbles:** modularize CLI, unify resources & trigger, global mcp, settings, and global --json ([#151](https://github.com/Francois-Esquire/foundry/issues/151))
* **marbles:** consolidate MCP server around 6 canonical tools ([#142](https://github.com/Francois-Esquire/foundry/issues/142))
* **marbles:** rename authoring launch to enqueue and regroup the CLI ([#140](https://github.com/Francois-Esquire/foundry/issues/140))
* **marbles:** add static pool config, keyed dispatch, and nested workflows ([#137](https://github.com/Francois-Esquire/foundry/issues/137))
* **marbles:** `observe(artifact, …)` handlers are typed `ArtifactEvent | ArtifactShareEvent`; `Runnable` requires `launch`; a monitor key collision now reports itself as a monitor.
* **marbles:** load providers explicitly with defineProvider ([#131](https://github.com/Francois-Esquire/foundry/issues/131))
* **marbles:** a workspace's .env.schema is no longer read; its variables must be in the environment of the Marbles process.

### Features

* **authorization:** add unified authorization control plane package ([#155](https://github.com/Francois-Esquire/foundry/issues/155)) ([52dcf21](https://github.com/Francois-Esquire/foundry/commit/52dcf21040ce554918ef0a69b45839f5d80fdb89))
* **authorization:** migrate callers to @foundry/authorization and retire legacy module ([#163](https://github.com/Francois-Esquire/foundry/issues/163)) ([ce867c4](https://github.com/Francois-Esquire/foundry/commit/ce867c4ca8c75996dead56a351e9ea85391ef702))
* **marbles:** add static pool config, keyed dispatch, and nested workflows ([#137](https://github.com/Francois-Esquire/foundry/issues/137)) ([ee3c17b](https://github.com/Francois-Esquire/foundry/commit/ee3c17b377e58482187c054dcaa33b0a1a07430a))
* **marbles:** consolidate MCP server around 6 canonical tools ([#142](https://github.com/Francois-Esquire/foundry/issues/142)) ([7aff00d](https://github.com/Francois-Esquire/foundry/commit/7aff00de5315ae8375dd76deba6a0c0ec455605a))
* **marbles:** interact with live work through its owning step ([#114](https://github.com/Francois-Esquire/foundry/issues/114)) ([de2b350](https://github.com/Francois-Esquire/foundry/commit/de2b3504c6a183347d9ed4c1dc52388cfc3128f2))
* **marbles:** launch declared steps and workflows by name ([#139](https://github.com/Francois-Esquire/foundry/issues/139)) ([ac76dc2](https://github.com/Francois-Esquire/foundry/commit/ac76dc2fd362508689e3d17aa3e1e4abf6e9483e))
* **marbles:** load providers explicitly with defineProvider ([#131](https://github.com/Francois-Esquire/foundry/issues/131)) ([0400077](https://github.com/Francois-Esquire/foundry/commit/0400077ec15fa000d6f74cbb116e8eb8ef1cd904))
* **marbles:** refine the authoring API surface ([#134](https://github.com/Francois-Esquire/foundry/issues/134)) ([0fe3562](https://github.com/Francois-Esquire/foundry/commit/0fe3562bf4448266a209e18202c36f9cf5ef11c4))
* **marbles:** remove Varlock environment loading ([#128](https://github.com/Francois-Esquire/foundry/issues/128)) ([3dcedc2](https://github.com/Francois-Esquire/foundry/commit/3dcedc2a534bc85e287fdc613269a3e8752cf4f2))
* **marbles:** rename authoring launch to enqueue and regroup the CLI ([#140](https://github.com/Francois-Esquire/foundry/issues/140)) ([17d1de3](https://github.com/Francois-Esquire/foundry/commit/17d1de358e71f405ab8434c25c136eee773ccd44))
* **queue:** extract @foundry/queue and @foundry/scheduling and unify @foundry/workflows runtime ([#143](https://github.com/Francois-Esquire/foundry/issues/143)) ([0894231](https://github.com/Francois-Esquire/foundry/commit/089423192caa0773d2c00fb3b863afea0197d448))
* **sandbox:** make sandboxes portable with pure Driver seam and cloud-native lifecycle ([#162](https://github.com/Francois-Esquire/foundry/issues/162)) ([ee3d8ea](https://github.com/Francois-Esquire/foundry/commit/ee3d8ea523622cf35bc6559a597383a74b675085))


### Bug Fixes

* **marbles:** an orphaned generation lets go of its parked runs instead of cancelling them ([#130](https://github.com/Francois-Esquire/foundry/issues/130)) ([01fc06b](https://github.com/Francois-Esquire/foundry/commit/01fc06b3225cc637c6862abafe614fcf1e6b5a39))
* **marbles:** contain dispatch_agent cwd and shut the MCP server down in order ([#119](https://github.com/Francois-Esquire/foundry/issues/119)) ([80975c3](https://github.com/Francois-Esquire/foundry/commit/80975c34c2be6ce8e78758f5781c0cc6a2dbf948))
* **marbles:** escalate engine stops, wait for staging on close, and guard a generation's retire ([#127](https://github.com/Francois-Esquire/foundry/issues/127)) ([8433f57](https://github.com/Francois-Esquire/foundry/commit/8433f5710c02ff34a2072693063263a3057fa7e1))
* **marbles:** follow a watched run across a handover ([#120](https://github.com/Francois-Esquire/foundry/issues/120)) ([3009883](https://github.com/Francois-Esquire/foundry/commit/3009883e1a71ee512e0200a688b23626c9863fb2))
* **marbles:** generate and gitignore bundled migrations ([#159](https://github.com/Francois-Esquire/foundry/issues/159)) ([e5c2a8e](https://github.com/Francois-Esquire/foundry/commit/e5c2a8e7927e9e98dddf6e49d811e9e3f22374cc))
* **marbles:** harden database reads, the client, shares and artifact links ([#124](https://github.com/Francois-Esquire/foundry/issues/124)) ([36f8699](https://github.com/Francois-Esquire/foundry/commit/36f86996d5fd841119bccb8259f5c2da69199e50))
* **marbles:** harden the daemon's workspace state, IPC and permissions ([#122](https://github.com/Francois-Esquire/foundry/issues/122)) ([32732ee](https://github.com/Francois-Esquire/foundry/commit/32732ee06d7e2b85acd9df1fd58933a463b81110))
* **marbles:** hold dashboard input, selection and mouse to the modal state ([#123](https://github.com/Francois-Esquire/foundry/issues/123)) ([ac91080](https://github.com/Francois-Esquire/foundry/commit/ac910809006505578d25a497de8feb90a8a3a1f6))
* **marbles:** keep fal and optional SDK types out of the published declarations ([#126](https://github.com/Francois-Esquire/foundry/issues/126)) ([f121620](https://github.com/Francois-Esquire/foundry/commit/f121620ece1f5b7ece24f4c96de2f44b4baf30e0))
* **marbles:** load workspace source as plain Bun would and bound Varlock ([#125](https://github.com/Francois-Esquire/foundry/issues/125)) ([a03652e](https://github.com/Francois-Esquire/foundry/commit/a03652e91b0196034a2987a2ec074f2137affd7c))
* **marbles:** parse command-line flags strictly ([#118](https://github.com/Francois-Esquire/foundry/issues/118)) ([98e1497](https://github.com/Francois-Esquire/foundry/commit/98e14973cbe755585940f980f6879894c33a661a))
* **marbles:** show the process and generations in status ([#115](https://github.com/Francois-Esquire/foundry/issues/115)) ([c10ec4c](https://github.com/Francois-Esquire/foundry/commit/c10ec4cf642ead96958fac4572d84af17a7c9638))
* **marbles:** tighten engine library edges found in review ([#121](https://github.com/Francois-Esquire/foundry/issues/121)) ([32c42f3](https://github.com/Francois-Esquire/foundry/commit/32c42f365d6eff2f2da46fef426264eb3721d302))


### Code Refactoring

* **agents:** remove unused subsystems ahead of the harness rewrite ([#154](https://github.com/Francois-Esquire/foundry/issues/154)) ([0eb9fbf](https://github.com/Francois-Esquire/foundry/commit/0eb9fbfa219d0725b6166cc227ae322477a2049d))
* **marbles:** modularize CLI, unify resources & trigger, global mcp, settings, and global --json ([#151](https://github.com/Francois-Esquire/foundry/issues/151)) ([ffce8ac](https://github.com/Francois-Esquire/foundry/commit/ffce8ac6f604371cdf056c66ba19d41ab4b111da))
* **models:** drop unused subsystems and Airplane Mode ([#152](https://github.com/Francois-Esquire/foundry/issues/152)) ([e34f501](https://github.com/Francois-Esquire/foundry/commit/e34f501cc99e92cb5721ed1df7f8819c7b7ad0b2))
* portable authoring, cloud store seams, and stateless execution primitives ([#156](https://github.com/Francois-Esquire/foundry/issues/156)) ([58ee506](https://github.com/Francois-Esquire/foundry/commit/58ee5062d0070366e4065252bb0391c814e4f2c3))
* **sandbox:** harden container lifecycle, ownership proof, and collapse wrappers ([#153](https://github.com/Francois-Esquire/foundry/issues/153)) ([559b9ff](https://github.com/Francois-Esquire/foundry/commit/559b9ff3f8b45edd1f7f020d5cca2bbaee1184df))

## [0.0.4](https://github.com/Francois-Esquire/foundry/compare/marbles-v0.0.3...marbles-v0.0.4) (2026-11-20)


### ⚠ BREAKING CHANGES

* **sandbox:** stateProviders is no longer exported from @foundry.sh/marbles/lib; call DatabaseProviderStore.forState(state).
* **marbles:** stateProviders is no longer exported from @foundry.sh/marbles/lib; call DatabaseProviderStore.forState(state).
* **marbles:** stateProviders is no longer exported from @foundry.sh/marbles/lib; call DatabaseProviderStore.forState(state).
* **marbles:** stateProviders is no longer exported from @foundry.sh/marbles/lib; call DatabaseProviderStore.forState(state).
* **marbles:** ProviderConfigurationOptions.state is replaced by `store`; the configuration is read by `read()` or `refresh()`, which a starting engine runs, not at construction. CONFIGURATION_PARTIAL is gone, since no write can land in part.
* **marbles:** ProviderConfigurationOptions.state is replaced by `store`; the configuration is read by `read()` or `refresh()`, which a starting engine runs, not at construction. CONFIGURATION_PARTIAL is gone, since no write can land in part.
* **marbles:** ProviderConfigurationOptions.state is replaced by `store`; the configuration is read by `read()` or `refresh()`, which a starting engine runs, not at construction. CONFIGURATION_PARTIAL is gone, since no write can land in part.
* **marbles:** `MemoryTaskStore` is no longer exported from `@foundry/tasks` or `@foundry/tasks/store`; import it from `@foundry/tasks/store/memory`.
* **agents:** `SessionStore` has `commit` and reads only; write through `new Sessions({ store })`. Import the store types from `@foundry/agents/store` and `InMemorySessionStore` from `@foundry/agents/store/memory`.
* **marbles:** `MemoryTaskStore` is no longer exported from `@foundry/tasks` or `@foundry/tasks/store`; import it from `@foundry/tasks/store/memory`.
* **workflows:** hold execution rules in one coordinator over memory and SQLite stores ([#86](https://github.com/Francois-Esquire/foundry/issues/86))
* **workspaces:** import `MemoryWorkspaceStore` from `@foundry/workspaces/store/memory` instead of `@foundry/workspaces`.
* **marbles:** Workspace no longer has touch(); existing workspace.json records are not imported, so a hosted workspace has to be attached again.
* **agents:** `SessionStore` has `commit` and reads only; write through `new Sessions({ store })`. Import the store types from `@foundry/agents/store` and `InMemorySessionStore` from `@foundry/agents/store/memory`.

### Features

* **agents:** add the SQLite session store and persist one JSON form in every store ([#85](https://github.com/Francois-Esquire/foundry/issues/85)) ([fd5ac1b](https://github.com/Francois-Esquire/foundry/commit/fd5ac1bdc74e78e36af235c7f65d5e3ba3f90baa))
* **agents:** define session store records as Zod schemas ([#67](https://github.com/Francois-Esquire/foundry/issues/67)) ([8ebaac2](https://github.com/Francois-Esquire/foundry/commit/8ebaac2b75c71c49c8fae4e4042f7c2fbab774f6))
* **agents:** one write point for sessions, with store transactions ([#76](https://github.com/Francois-Esquire/foundry/issues/76)) ([92336c1](https://github.com/Francois-Esquire/foundry/commit/92336c1b008d69c88e27749a49056542282fc24e))
* **artifacts:** add the SQLite store and its tables ([#84](https://github.com/Francois-Esquire/foundry/issues/84)) ([06e38fa](https://github.com/Francois-Esquire/foundry/commit/06e38fab26ccc7e9e3238eb335986f5861de0244))
* **artifacts:** define persisted records as Zod schemas ([#70](https://github.com/Francois-Esquire/foundry/issues/70)) ([83cd472](https://github.com/Francois-Esquire/foundry/commit/83cd4724758798847bd78af7dd7bab5ce343323b))
* **artifacts:** one atomic store commit, transactions and paged listing ([#75](https://github.com/Francois-Esquire/foundry/issues/75)) ([823ee85](https://github.com/Francois-Esquire/foundry/commit/823ee85b45684a218b1eb24a5361acd189fa2231))
* **artifacts:** stage blob bytes before the store transaction ([#82](https://github.com/Francois-Esquire/foundry/issues/82)) ([26be7aa](https://github.com/Francois-Esquire/foundry/commit/26be7aadabe54954fc062ce0c17b08f9d8791758))
* **marbles:** add durable embedded execution and host tasks ([#55](https://github.com/Francois-Esquire/foundry/issues/55)) ([79ea35b](https://github.com/Francois-Esquire/foundry/commit/79ea35b42b1cd2ac52e05e398deeea99c9d3dc6f))
* **marbles:** add Textbook splash story ([bd4363d](https://github.com/Francois-Esquire/foundry/commit/bd4363d931782dd60c1255c3746c40c6feb2fd3c))
* **marbles:** add the Marbles database and record workspaces in it ([#79](https://github.com/Francois-Esquire/foundry/issues/79)) ([656f4b7](https://github.com/Francois-Esquire/foundry/commit/656f4b7cbf0152a1e7f7b85382f5c56f14cd6a0d))
* **marbles:** check model availability and discover live catalogs ([#108](https://github.com/Francois-Esquire/foundry/issues/108)) ([b15524f](https://github.com/Francois-Esquire/foundry/commit/b15524f625f02c53294c4a2832bc0ab31b01b8de))
* **marbles:** export prompts, ship marbles mcp, and read prices and skills from direct sources ([#65](https://github.com/Francois-Esquire/foundry/issues/65)) ([b51ad17](https://github.com/Francois-Esquire/foundry/commit/b51ad1713369b7676cb694d3050b31cd151f428c))
* **marbles:** host every workspace in one engine generation and switch generations on change ([#98](https://github.com/Francois-Esquire/foundry/issues/98)) ([b90c18d](https://github.com/Francois-Esquire/foundry/commit/b90c18d5abe8623c8b74ec44a3f056c56198ea26))
* **marbles:** host several workspaces in one process, each run with its own execution context ([#96](https://github.com/Francois-Esquire/foundry/issues/96)) ([10aabc0](https://github.com/Francois-Esquire/foundry/commit/10aabc02ff76c9c479c782df28a24fe975193f40))
* **marbles:** keep all remaining state in the Marbles database and derive every path from the Foundry home ([#95](https://github.com/Francois-Esquire/foundry/issues/95)) ([308794a](https://github.com/Francois-Esquire/foundry/commit/308794ab382536a3c0a8b9e2c827552230f16fa9))
* **marbles:** keep artifacts, sandbox containers and the workspace catalogue in the Marbles database ([#89](https://github.com/Francois-Esquire/foundry/issues/89)) ([b07767b](https://github.com/Francois-Esquire/foundry/commit/b07767b51963b6d70c47b39d752ef74f14a29107))
* **marbles:** keep execution runs, automations and usage in the Marbles database ([#94](https://github.com/Francois-Esquire/foundry/issues/94)) ([c7d1b47](https://github.com/Francois-Esquire/foundry/commit/c7d1b473c41582aed5611fa0b6daafe35bc029e7))
* **marbles:** keep sessions in the Marbles database ([#88](https://github.com/Francois-Esquire/foundry/issues/88)) ([8e5d159](https://github.com/Francois-Esquire/foundry/commit/8e5d1595b1df16675aeedaaebb9f69bcc40f2ec5))
* **marbles:** keep tasks in the Marbles database and deliver changes from it ([#83](https://github.com/Francois-Esquire/foundry/issues/83)) ([dc6eb44](https://github.com/Francois-Esquire/foundry/commit/dc6eb4407aff542595bdba05531bf49b49075d9b))
* **marbles:** keep workflow runs, schedule ticks and monitor state in the Marbles database ([#92](https://github.com/Francois-Esquire/foundry/issues/92)) ([24eebed](https://github.com/Francois-Esquire/foundry/commit/24eebed42f19c41cb53f75054c0f3bbce8b1ef1d))
* **marbles:** observe every source over one change log ([#99](https://github.com/Francois-Esquire/foundry/issues/99)) ([6aa0360](https://github.com/Francois-Esquire/foundry/commit/6aa03604afc65c5f41ebf96c0e59c9028762a7b7))
* **marbles:** recover the database, containers and child processes at engine start ([#97](https://github.com/Francois-Esquire/foundry/issues/97)) ([3e0bdee](https://github.com/Francois-Esquire/foundry/commit/3e0bdeef08481fdd7e852a67bd287516a833b42e))
* **marbles:** render portable prompts for the selected harness ([#110](https://github.com/Francois-Esquire/foundry/issues/110)) ([e5826c7](https://github.com/Francois-Esquire/foundry/commit/e5826c73cbc6f578ad01bbf8c38a209c448a9598))
* **marbles:** share resources between workspaces, link artifacts, and view every workspace ([#100](https://github.com/Francois-Esquire/foundry/issues/100)) ([4fe9060](https://github.com/Francois-Esquire/foundry/commit/4fe9060dae22f19c5b54abcb78a4c12dc6b2bc67))
* **modules:** centralize the reusable Module library ([#53](https://github.com/Francois-Esquire/foundry/issues/53)) ([3e5548c](https://github.com/Francois-Esquire/foundry/commit/3e5548c300f576caaf01fcdc34b08389cf01a498))
* **sandbox,workspaces,agents:** carry change events in the store write ([#90](https://github.com/Francois-Esquire/foundry/issues/90)) ([b2c585f](https://github.com/Francois-Esquire/foundry/commit/b2c585f072de3e461042af70bbbdbbb4f658901d))
* **sandbox:** commit container rows atomically through @foundry/sandbox/store ([#73](https://github.com/Francois-Esquire/foundry/issues/73)) ([7c8662d](https://github.com/Francois-Esquire/foundry/commit/7c8662dcee3286ebead2481d37801d93bdb2a632))
* **sandbox:** define container store records as Zod schemas ([#68](https://github.com/Francois-Esquire/foundry/issues/68)) ([8e35495](https://github.com/Francois-Esquire/foundry/commit/8e354958b820a8b598dfca111bda3b84cac39443))
* **sandbox:** SQLite container store, and the registry keeps every VM it could not remove ([#81](https://github.com/Francois-Esquire/foundry/issues/81)) ([1ec7117](https://github.com/Francois-Esquire/foundry/commit/1ec711790d1902e41622665cabe4b8d9ddc784c3))
* **tasks:** define task store records as Zod schemas ([#69](https://github.com/Francois-Esquire/foundry/issues/69)) ([73bb830](https://github.com/Francois-Esquire/foundry/commit/73bb830c60e5f05e0afa3131e9715cd976afc1e7))
* **tasks:** SQLite store, tables and conformance suite beside the in-memory store ([#77](https://github.com/Francois-Esquire/foundry/issues/77)) ([d812871](https://github.com/Francois-Esquire/foundry/commit/d812871dfedb0b65d9a9d99016e5ff383141f442))
* **usage:** read remaining allowance and shared budgets ([#109](https://github.com/Francois-Esquire/foundry/issues/109)) ([4b056ca](https://github.com/Francois-Esquire/foundry/commit/4b056ca494dfdf135c5f57136d73e3f9f952d035))
* **workflows,artifacts:** carry change events in the store write ([#91](https://github.com/Francois-Esquire/foundry/issues/91)) ([c368875](https://github.com/Francois-Esquire/foundry/commit/c36887557737e17aa7fd9fdebe2ff11d5529e0aa))
* **workflows:** define persisted records as Zod schemas ([#78](https://github.com/Francois-Esquire/foundry/issues/78)) ([fea25ba](https://github.com/Francois-Esquire/foundry/commit/fea25ba1ea1a5264db83d537e572505fbe916e0f))
* **workflows:** hold execution rules in one coordinator over memory and SQLite stores ([#86](https://github.com/Francois-Esquire/foundry/issues/86)) ([466a968](https://github.com/Francois-Esquire/foundry/commit/466a9688228e0d2b546f9e0158a80f3a18027fd8))
* **workspaces:** define persisted records as Zod schemas ([#71](https://github.com/Francois-Esquire/foundry/issues/71)) ([859a3e3](https://github.com/Francois-Esquire/foundry/commit/859a3e33941d8b874a5635584b4abf85f08c4c11))
* **workspaces:** one atomic commit and a transaction on the Workspace store ([#74](https://github.com/Francois-Esquire/foundry/issues/74)) ([bb908c3](https://github.com/Francois-Esquire/foundry/commit/bb908c3b5e156b48c1686995f7cfa72737b6e970))
* **workspaces:** SQLite store and tables beside the in-memory store ([#80](https://github.com/Francois-Esquire/foundry/issues/80)) ([49ae4bf](https://github.com/Francois-Esquire/foundry/commit/49ae4bff34b51ec8bc3b1871c1d7b46b36e6570a))


### Bug Fixes

* **marbles:** keep test temp directories in one per-run root ([#72](https://github.com/Francois-Esquire/foundry/issues/72)) ([e91e208](https://github.com/Francois-Esquire/foundry/commit/e91e2085a6159aa74d05829d9ac2ea30f4494570))
* **marbles:** load optional provider SDKs on demand ([7743011](https://github.com/Francois-Esquire/foundry/commit/77430117aa00fa24066b2b8567180f091ed17a8f))
* **marbles:** preserve Textbook story teardown ([e6fad28](https://github.com/Francois-Esquire/foundry/commit/e6fad282ff70cfa156722681523dab6e7a5eee74))
* **workflows:** persist cancelled step state ([5caa1d9](https://github.com/Francois-Esquire/foundry/commit/5caa1d97e259798bab237595c78791f2e1988993))


### Code Refactoring

* **sandbox:** make the container stores classes ([#102](https://github.com/Francois-Esquire/foundry/issues/102)) ([a2c5abc](https://github.com/Francois-Esquire/foundry/commit/a2c5abc6b0ef88a901747f37f31876de626f5a35))

## [0.0.3](https://github.com/Francois-Esquire/foundry/compare/marbles-v0.0.2...marbles-v0.0.3) (2026-11-08)


### Features

* **marbles:** add operating dashboard, settings and usage accounting ([#32](https://github.com/Francois-Esquire/foundry/issues/32)) ([1898a39](https://github.com/Francois-Esquire/foundry/commit/1898a394c945d58b63fedd9cb0547acdf45e8437))
* **marbles:** add STDIO MCP dispatch and run watching ([#20](https://github.com/Francois-Esquire/foundry/issues/20)) ([e9d6e69](https://github.com/Francois-Esquire/foundry/commit/e9d6e6928e27ab4a89c9cbbc2ec7d2861af32a0e))
* **marbles:** build agent definitions when sessions open ([#30](https://github.com/Francois-Esquire/foundry/issues/30)) ([44c7a27](https://github.com/Francois-Esquire/foundry/commit/44c7a270cf5a7b35d95d978760cfadaeb710f541))
* **marbles:** expose workspace tasks through CLI and MCP ([#31](https://github.com/Francois-Esquire/foundry/issues/31)) ([904db8e](https://github.com/Francois-Esquire/foundry/commit/904db8e435b06ba27958efc68d32860478971588))
* **marbles:** one Marbles process per machine, hosting each workspace in a worker ([#24](https://github.com/Francois-Esquire/foundry/issues/24)) ([1572120](https://github.com/Francois-Esquire/foundry/commit/1572120cab14b95b541f25fe08c25191e61bd345))
* **marbles:** route ready tasks through reviewed pipelines ([#34](https://github.com/Francois-Esquire/foundry/issues/34)) ([7521c35](https://github.com/Francois-Esquire/foundry/commit/7521c3533068a28c52ea0c26c4fa7077261e073c))
* **prompts/vscode:** Editor and lint tooling for prompts: VS Code extension ([#11](https://github.com/Francois-Esquire/foundry/issues/11)) ([f561598](https://github.com/Francois-Esquire/foundry/commit/f561598fd1bcf318a008ef21154522065720d02c))
* **tasks:** add tags and durable workspace event delivery ([#29](https://github.com/Francois-Esquire/foundry/issues/29)) ([23e151c](https://github.com/Francois-Esquire/foundry/commit/23e151c3c7599c72c2f9a475150e94f22ee09856))
* **tasks:** the Task backlog package, exported from Marbles ([#26](https://github.com/Francois-Esquire/foundry/issues/26)) ([08daa85](https://github.com/Francois-Esquire/foundry/commit/08daa85b59951023b5a112c1074a0d0ca8dd76f2))
* **usage:** read subscription usage, and pick a Marbles agent's route from it ([#25](https://github.com/Francois-Esquire/foundry/issues/25)) ([b80cc01](https://github.com/Francois-Esquire/foundry/commit/b80cc0138a736ab482da4cd94464ea81ec23600f))


### Bug Fixes

* correct edge cases across storage, process, parsing and tool handling ([#27](https://github.com/Francois-Esquire/foundry/issues/27)) ([23d01d0](https://github.com/Francois-Esquire/foundry/commit/23d01d0d52fd42b5193195bce7d12f24eb185cdc))

## [0.0.2](https://github.com/Francois-Esquire/foundry/compare/marbles-v0.0.1...marbles-v0.0.2) (2026-10-17)


### Features

* **models:** add Pi harness support ([fd1b104](https://github.com/Francois-Esquire/foundry/commit/fd1b104dde8a876d10d449af18f70c5872d59ddf))


### Bug Fixes

* **models:** use the community Pi AI SDK provider ([e11444a](https://github.com/Francois-Esquire/foundry/commit/e11444ac2f2646efcee21fbbbf5505c3c46f4dac))

## 0.0.1 (2026-10-14)


### ⚠ BREAKING CHANGES

* **marbles:** Import @foundry.sh/marbles, @foundry.sh/marbles/lib, and @foundry.sh/marbles/prebuilt instead of the old @foundry/marbles paths. The first alpha remains version 0.0.1.
* **marbles:** artifacts pass versions, reads, and provenance through
* **marbles:** sandbox handles pass the container through
* **marbles:** workspace handles pass the package Workspace through
* **marbles:** An agent's id is its name, else the const it is bound to, else agent-<digest of prompt, provider and model>; it was its registration order (agent#N). Grants approved for future runs under agent#N no longer match: approve again when asked. Triggers an agent created keep firing but leave its list_automations; pause or delete them from the dashboard, or set owner.agentId in the automation record. Two different agents with one id now fail at import. WorkflowRecord.tree is removed; a static tree is a setup that returns it. A workflow is only ever a run root. HarnessInteractions.registerSession takes the authority returned by authority(), and HarnessActivities.attach returns the session to use. createSession with an existing id returns that session unchanged.

### Features

* **prompts:** add harness prompt dialects with live reference checks ([#10](https://github.com/Francois-Esquire/foundry/issues/10)) ([2fcbfa6](https://github.com/Francois-Esquire/foundry/commit/2fcbfa6071cc63b35dea9ffeffde5a6fde345cf6))
* **release:** centralize package assets and linked library versions ([7842d1d](https://github.com/Francois-Esquire/foundry/commit/7842d1dfc79b5ace5ad4fea3aa629abab03deb71))
* **agents,marbles:** pass structured output and model settings through agent turns ([10924f1](https://github.com/Francois-Esquire/foundry/commit/10924f1b907d0693b1b63505456a895ecd9345fb))
* **agents:** export capability schemas and session record builders ([08178cd](https://github.com/Francois-Esquire/foundry/commit/08178cd264c3d381411bade32f88959d9dfe95f2))
* **artifacts:** add JSON artifact store ([ad9bd84](https://github.com/Francois-Esquire/foundry/commit/ad9bd84e3ffcdca3b0737ed2c158d0c09c3ac16b))
* **artifacts:** add versioned artifact storage package ([4e6f196](https://github.com/Francois-Esquire/foundry/commit/4e6f19672622e81ead83f3e111f895c2662b82ee))
* **spyglass:** add spyglass apply ([cba611e](https://github.com/Francois-Esquire/foundry/commit/cba611e3419a572b2e25ed27ae583ee81047e32c))
* **spyglass:** add the library serve and retire the second server ([630af14](https://github.com/Francois-Esquire/foundry/commit/630af140ddc6642f504958272f4a27fdf1929303))
* **spyglass:** harden the mutator and preview an authorized plan ([4aa6b2a](https://github.com/Francois-Esquire/foundry/commit/4aa6b2a337f5a5ffc0fab52e61efd329b83f1b51))
* **spyglass:** lock the state directory and keep a workspace record ([9408044](https://github.com/Francois-Esquire/foundry/commit/94080446cf2367207af2d495ea81dbf6da253401))
* **harness:** run coding agents in MicroSandbox ([1ef0f4f](https://github.com/Francois-Esquire/foundry/commit/1ef0f4f0e4be5bd819438513a6681687c440ec60))
* **lib:** file-backed grant repository on the reference transitions ([a99b276](https://github.com/Francois-Esquire/foundry/commit/a99b27654c4a517ebb943640b5c2925e5d28c46f))
* **marbles,agents:** skill files as bytes, skills defined in code, skills.none() ([858dd3a](https://github.com/Francois-Esquire/foundry/commit/858dd3a3eec046c4057d60591f7a89736f4162c2))
* **marbles,lib:** command steps and a body's exec ([aa34e6d](https://github.com/Francois-Esquire/foundry/commit/aa34e6d97ebb16e88eb716653456b48da1132c1c))
* **marbles:** artifacts pass versions, reads, and provenance through ([e736b5d](https://github.com/Francois-Esquire/foundry/commit/e736b5d9244cc5ab723a4b6a313593af25021df2))
* **marbles:** artifacts.latest, memory between runs ([e74400d](https://github.com/Francois-Esquire/foundry/commit/e74400d71259af9b2730f31d987010396bc8269f))
* **marbles:** discover workspace modules and initialize starters ([a9fd994](https://github.com/Francois-Esquire/foundry/commit/a9fd994f7720cf67a6d9aad1ca8533152f91df2e))
* **marbles:** load a workspace .env.schema before modules, ticks run in the root ([a98afc2](https://github.com/Francois-Esquire/foundry/commit/a98afc243f0ecc85ea198b62538064b8b8a24468))
* **marbles:** make agent, step, and workflow definitions usable ([a6ab8a4](https://github.com/Francois-Esquire/foundry/commit/a6ab8a480c78c750498c75595a47ccc5b8ce1e1d))
* **marbles:** make workspace, sandbox, and artifact definitions usable ([6808ea0](https://github.com/Francois-Esquire/foundry/commit/6808ea03df79e37a933022b8bb30f0285dba9755))
* **marbles:** rename public package to [@foundry](https://github.com/foundry).sh/marbles ([d85d06c](https://github.com/Francois-Esquire/foundry/commit/d85d06c47ad12085bda5780994c8fccfc890d3d9))
* **marbles:** request options for HTTP monitors ([daeab1e](https://github.com/Francois-Esquire/foundry/commit/daeab1e69b1b5efcb43a63e4343c66988bad771d))
* **marbles:** sandbox handles pass the container through ([4d8026a](https://github.com/Francois-Esquire/foundry/commit/4d8026a13b12fa2909eb4c4fb674d59a954989ef))
* **marbles:** step retry and timeout, and bail ([59edd62](https://github.com/Francois-Esquire/foundry/commit/59edd627382db6471317b4c1dde0da2eeeb29272))
* **marbles:** workspace handles pass the package Workspace through ([af4958f](https://github.com/Francois-Esquire/foundry/commit/af4958ff100f9b6473152ca770c698c52cf23a84))
* **quirks:** add child agents and durable automation ([6b4dea1](https://github.com/Francois-Esquire/foundry/commit/6b4dea1b864d5b670c83e94c001f721564acdda0))
* **quirks:** copy app and supporting packages ([addb1fb](https://github.com/Francois-Esquire/foundry/commit/addb1fb5915f248201caba4f714f4dfa449e3401))
* **release:** prepare independent releases and gated npm publishing ([bd33566](https://github.com/Francois-Esquire/foundry/commit/bd3356662761d8e36d4c187e26a69a82c56357fd))
* **sandbox:** add portable sandbox package and integration coverage ([b8f0f5b](https://github.com/Francois-Esquire/foundry/commit/b8f0f5b6ea7e2c32fe0b6ae0902cbc7ce7fdeb0e))
* sync agent composition and workspace file creation ([7a2f752](https://github.com/Francois-Esquire/foundry/commit/7a2f752d86372eac6df74353ab4d0823bac52eb5))
* **workflows,quirks:** run streams with replay and path-scoped chunks ([5e988a8](https://github.com/Francois-Esquire/foundry/commit/5e988a8ee9f4bb876cec55faf16237adf5081d49))
* **workspaces:** adopt shared storage entries and align Quirks ([d936e5c](https://github.com/Francois-Esquire/foundry/commit/d936e5c8b333acd3742a869c1708f6eb91318b81))
* **workspaces:** drive Quirks monitoring through workspace change events ([31d7375](https://github.com/Francois-Esquire/foundry/commit/31d73756b5d1b4ffadbfdc09881454a83bdd716f))
* **workspaces:** support filesystem-resolved sources and load references ([8a20bfe](https://github.com/Francois-Esquire/foundry/commit/8a20bfed18fa3a44231feb7c17eede9b96e6d687))


### Bug Fixes

* **marbles:** unify execution and harden runtime lifecycle ([5a59f1e](https://github.com/Francois-Esquire/foundry/commit/5a59f1e2aecaae346981bbac5e022d9027e086fa))
* **agents:** resume a session created again and export session enums ([41fa124](https://github.com/Francois-Esquire/foundry/commit/41fa124c30803d185d671e6ddd9e7699a6fbb3d6))
* **agents:** settle abandoned streams and close review gaps ([6c8a17f](https://github.com/Francois-Esquire/foundry/commit/6c8a17fde778509276da0a975135fb520cc5907f))
* **ci:** avoid expensive buffer assertions and retain bundled model types ([81b5790](https://github.com/Francois-Esquire/foundry/commit/81b579091fc1b4df7b80da81a416525370815a34))
* **ci:** bound nested test workers and isolate package suites ([8e1642b](https://github.com/Francois-Esquire/foundry/commit/8e1642b0b4870a86a7f862caa942655d29b4a567))
* **ci:** bound test concurrency and budget consumer compilation ([07b577f](https://github.com/Francois-Esquire/foundry/commit/07b577faaac343f33ad78b55be6319015267c3b2))
* **knip:** make workspace dead-code check pass ([30e4752](https://github.com/Francois-Esquire/foundry/commit/30e475297d249ba18916351a99e2873f59771579))
* **lib:** harden the file lock against wedges, stray releases and racing breakers ([d249694](https://github.com/Francois-Esquire/foundry/commit/d249694d93ab37e8ec5a49a675993d463833b243))
* **lib:** share the queue and lock, pin grant schemas, flush directories ([6b9def0](https://github.com/Francois-Esquire/foundry/commit/6b9def0ae82b2af587869dff71ecf59c6526f10f))
* **marbles,workflows:** one-line errors for bad input and a roll at an ask ([a70542c](https://github.com/Francois-Esquire/foundry/commit/a70542c5dd84738ca44265b850a478db04ecf1f1))
* **marbles,workspaces:** worktree defaults everywhere, replayed creates, hasBranch ([830ca17](https://github.com/Francois-Esquire/foundry/commit/830ca17d48d89359187a072df9435c2ad0c72cf6))
* **marbles:** fail a step whose result is not JSON instead of hanging ([c97bb1b](https://github.com/Francois-Esquire/foundry/commit/c97bb1bd173dce962af09cddcdbc5099ed8cba1e))
* **marbles:** harden run lifecycle and session contracts ([5fe38ac](https://github.com/Francois-Esquire/foundry/commit/5fe38acecab7f911bb19e764d2cf8178a07bd9ec))
* **marbles:** map the types build from package exports ([b33f6e9](https://github.com/Francois-Esquire/foundry/commit/b33f6e9302154a764ec384ec683e19c7afa490bf))
* **marbles:** never overwrite an unreadable session file ([1571a3e](https://github.com/Francois-Esquire/foundry/commit/1571a3e099539cbe0816325f99af39b62d95cb7b))
* **marbles:** reject zero cadences and carry launchd flags through dry runs ([8e386f1](https://github.com/Francois-Esquire/foundry/commit/8e386f10058575da6ac99c65761face4408964bc))
* **models:** export every runtime module the docs promise ([9a52994](https://github.com/Francois-Esquire/foundry/commit/9a52994d6eae031ae6cb993454ba522bb9b1fcb2))
* **models:** keep kind defaults in step with registration ([eb7a768](https://github.com/Francois-Esquire/foundry/commit/eb7a768c4bbd50b6dac3badcd9962d564f5d4e62))
* **models:** validate settings where they enter and keep defaults across re-registration ([539da34](https://github.com/Francois-Esquire/foundry/commit/539da344efdab9ab34d967809fa345d9bd468cbd))
* **models:** validate the kind defaults settings route by ([588781e](https://github.com/Francois-Esquire/foundry/commit/588781e5f55e58c312fac6aa8183afa2888dc7dc))
* **sandbox:** resolve every process cwd alike, apply registry config, unify errors ([3ba0ce0](https://github.com/Francois-Esquire/foundry/commit/3ba0ce0ee639bdf0ef803a501f450a95ace23bc6))
* **workspaces:** refresh source after pending watcher scans ([2394604](https://github.com/Francois-Esquire/foundry/commit/2394604f42e440d5c4192e3a4aefe50e617da309))


### Documentation

* **marbles:** document the programmatic engine, agent identity, state and locks ([06332ba](https://github.com/Francois-Esquire/foundry/commit/06332ba3738806005b99068c9fd438d677271e3f))

## Marbles changelog

The first planned release is **0.0.1 (alpha)**. Every `0.0.x` release may
introduce breaking changes. `0.1.0` is the first supported API milestone.
Release Please prepares package-specific entries from Conventional Commits.

## Unreleased

`@foundry.sh/marbles/lib` is a programmatic library. A program builds an
`Engine` from explicit instances, then drives and inspects it without the
CLI, the dashboard, or the authoring words; the engine owns its run scopes and
its trigger state. The Marbles CLI and dashboard are one host on top of it.

### Breaking changes

* **Agent ids.** An agent's id was its registration order (`agent#1`,
  `agent#2`, …). It is now the `name` you give it, else the top-level `const`
  the `agent({...})` call is assigned to, else `agent-<digest>` (the first 16
  hex digits of a SHA-256 of its prompt, provider and model). Tool grants
  approved "for future runs" and the triggers an agent creates are filed under
  this id, so records written under `agent#N` no longer match any agent:
  * The next run asks again for each tool it had a grant for. Approve it again.
    The old `agent#N` grants in `agent-grants.json` are inert. Do not edit that
    file by hand, because the grant store refuses an entry whose address does
    not match its subject.
  * Triggers created by agents keep firing, but their agents no longer list or
    manage them. Pause or delete them from the dashboard (select the trigger,
    then `p` or `k`). To hand one back, set `owner.agentId` in
    `<state>/<workspace-id>/automations/<id>.json` to the agent's new id; the
    record stays with the session that created it.
  * Two different agents that resolve to the same id fail at import with
    `agent "<id>" already declared (<file:line>) with a different prompt or
    route (<file:line>); rename one or name it explicitly`. Declaring the
    same agent twice (same prompt and route) is allowed.
* `WorkflowRecord.tree` is removed and `WorkflowRecord.setup` is required. A
  static tree is a setup that returns it.
* `Shared.inferred`, `Shared.site` and `Shared.uninferable` are replaced by
  two host-supplied strings: `origin` (where the definition was declared,
  quoted in messages) and `nameHint` (how to name a nameless definition).
* A workflow cannot be a child in another tree. Locking one as a child throws
  `child "<key>" is a workflow; a workflow can only be the root of a run`, and
  a setup that returns such a tree fails before any of it runs.
* `HarnessInteractions.registerSession(session, authority)` takes the
  `SandboxAuthority` that `authority()` returned, and only that object
  registers a session as durable. `HarnessActivities.attach(sessionId,
  session, { delegated? })` returns the session to hold and close.
* `createSession` with the id of an existing session returns that session
  unchanged, history included, instead of replacing it. This holds for
  Marbles' `JsonSessionStore` and for `InMemorySessionStore` in
  `@foundry/agents`.

### Fixed

* A zero cadence (`"0s"`, `"000m"`) or one past `Number.MAX_SAFE_INTEGER` is
  refused by `schedule().every/at`, `monitor().every` and agent-created
  automations.
* `launchd install` passes `--artifacts` and each `--harness` to the scheduled
  `roll`. Under `--dry-run`, `launchd install` prints the plist path and
  contents and the `launchctl` commands, `launchd uninstall` prints the
  `launchctl bootout` command and the plist it would remove, and neither
  changes anything.
* `--dry-run` persists nothing: no sessions, runs, grants, approvals, agent
  triggers, or heartbeat.
* Names inferred from a `const` (steps, workflows and agents) are read from
  the formatted stack, so they are correct under loaders that transpile
  (vitest, tsx, source maps).
* `JsonSessionStore` re-reads the session file for every operation. Each
  change is a read-change-write under a per-session lock file
  (`sessions/<id>.json.lock`), so two processes no longer lose each other's
  messages. A session file that cannot be read is skipped with a warning and
  never overwritten. Changing that session throws and asks you to repair or
  remove the file.
* Schedule, run and automation-edit locks (`<state>/<workspace-id>/locks/`)
  and session locks share one protocol:
  * A lock whose holder has exited is taken over, one process at a time,
    through a transient `<lock>.break` file. If a crashed process leaves a
    `.break` file behind, nobody takes that lock over until it is removed.
  * A lock file left empty (its creator died before writing its pid) is broken
    after 30 seconds. Until then, `roll` prints `held by a process that is
    taking it now; retry`.
  * A lock file that is neither a pid nor empty is never removed. `roll`
    prints `held by an unknown process (if none is running, remove <path>)`.
  * Releasing a lock never removes a lock another process has taken since.
  * Lock files are created with mode `0o600`.
  * A skipped tick prints `skipped: held by <holder>`. The automation edit
    lock's error names the holder.
* The dashboard shows "Waiting for approval" and "Waiting for answer" in the
  warning color. `s`, `p` and `k` follow the selected run's status: steer
  and pause while running, resume while paused, cancel only an unsettled run.
* The dashboard shows errors as their message, without an `Error:` prefix.

### Changed

* The CLI rejects a bad command line before it loads any module or touches
  state. This covers an unknown command, wrong positionals (`roll a b`, a
  name after `run`, extra arguments to `list`, `status` or `sessions`, an
  unknown starter) and an unknown `--harness` id. The message and usage go to
  stderr and the exit code is 1. `--help` wins over everything else on the
  line.
* `status` and `sessions` find the workspace without executing its modules.
  They no longer print a `[source]` line, and they work when a module is
  broken.
* Only a run that persists writes `workspace.json` (`run`, `roll`, and the
  dashboard after Enter, never under `--dry-run`). `list`, `launchd`,
  `sessions` and `status` leave the state root as they found it.
* `list` prints triggers that agents created as monitors:
  `[monitor] <key> <source> <cadence>`, not `[schedule] … → __automation_monitor`.
  Cadences read `every 1h`, `daily at 09:00`, or `mon, fri at 09:00`. Config
  schedules come first, then config monitors, then triggers that agents created.
* Automation errors are keyed by automation id, not by file name.
* An engine without a state dir now takes real schedule locks: ticking one
  key twice at once gets `skipped: held by this process`, as a second process
  would.
* The setup screen lists Claude Code before Codex, which is also the order
  used to pick the first available harness.
* Dashboard footer:
  * `p pause` and `p resume` are separate hints.
  * `l launch` shows only on definitions, and `b run` only on steps and
    activities.
  * While typing, the bottom line lists only `Ctrl+C quit`.
  * The search and prompt lines read `Type to search · Enter apply · Esc
    clear` and `steer · Enter send · Esc cancel`.
* Esc or `h` from empty details returns to the list you were on.

### Added

* `agent({ name })` gives an agent an explicit, durable id.
* Library (`@foundry.sh/marbles/lib`):
  * `EngineOptions.store` and `engine.store`. Pass a `StateStore` for trigger
    history, monitor observations and agent-created triggers, with the locks
    that keep two ticks apart. By default the engine uses a `JsonStateStore`
    over `state`, or an `InMemoryStateStore` without `state`. Also exported:
    `StateStore`, `StateCollection`, `StoredDocument`, `JsonStateStore`,
    `InMemoryStateStore`, `Lock` and `HeldLock` (`holder` says who has the
    lock). Store keys and lock names must be plain names.
  * `EngineOptions.workspaces` is optional. Without it the engine builds a
    watched workspace system over the local filesystem whose `git()` layer
    uses the `git` option.
  * `EngineOptions.worktrees` and `Engine.worktreesFor(state)`, the default
    place worktrees are cut.
  * `engine.scopes`, a `ReadonlyRunScopes` view (`get`, `has`, `size`,
    iteration) of the live runs' `RunScope`s.
  * `SandboxesManager.containerOf(sandbox)` returns the container behind a
    sandbox this engine opened.
  * `CLI_HARNESS_IDS` (in preference order) and `CLI_HARNESSES`, the single
    description of each CLI harness. Types: `CliHarness`,
    `CliHarnessDescriptor`, `GuestArchitecture`, `GuestArtifact`,
    `GuestAuth`, `GuestFile`.
  * `TERMINAL_RUN_STATUSES`, the run statuses that are settled.
  * Types `NamedDefinition`, `SandboxAuthority` and `JsonSessionStoreOptions`.
    `new JsonSessionStore(dir, { warn })` reports skipped files.
* Packages bundled into Marbles:
  * `@foundry/lib/atomic-file`: `writeFileAtomic` (exclusive temp file and
    rename, optional mode and fsync of the file and its directory),
    `readJsonFile`, `hasErrorCode`.
  * `@foundry/lib/file-lock`: `tryFileLock`, `acquireFileLock`,
    `withFileLock`, `lockHolder`, `processAlive`, `FileLockTimeoutError`. The
    protocol above (`FileLockHolder.empty` marks an empty lock).
  * `@foundry/lib/keyed-queue` (`KeyedQueue`) and `@foundry/lib/exactly`
    (`Exactly<Output, T>`).
  * `@foundry/lib/config/authorization/file`: `FileGrantRepository`, a
    file-backed grant repository generic over subject and capability schemas.
    `config/authorization/grant-state` holds the grant transitions it shares
    with the in-memory repository.
  * `@foundry/agents/authorization`: `capabilitySchema` and
    `agentSubjectSchema`.
  * `@foundry/agents/session`: `newSessionRecord`, `patchSessionRecord`,
    `newSessionMessage`, `patchSessionMessage`, and `SESSION_ROLES`,
    `MESSAGE_STATUSES`, `SESSION_STATUSES`.

## Historical repository notes (2026-09-16; unpublished)

### Features

* adapters ([852c0cf](https://github.com/Francois-Esquire/foundry/commit/852c0cfad0534e96cd88d5e6b896518b617638b7))
* add memory and examples ([de0e0e1](https://github.com/Francois-Esquire/foundry/commit/de0e0e17af6e65e3304e04d8479cd8aacc008d20))
* **agent:** cleaner agent framework ([d085d35](https://github.com/Francois-Esquire/foundry/commit/d085d356a64ec13ba1869c23093782d2dd0e28ef))
* **cli:** add command line app ([625a67a](https://github.com/Francois-Esquire/foundry/commit/625a67ab6b8711384e43b316919f2603392efbfd))
* create artifacts ([1e82dae](https://github.com/Francois-Esquire/foundry/commit/1e82dae0fff7d7c33e25c5b1b9074a32c3be762b))
* **detector:** add detector/analyzer ([814b33d](https://github.com/Francois-Esquire/foundry/commit/814b33dda04f139240edf0fc76f9961b76d3f7ac))
* **memory:** add knowledge ([3b37f85](https://github.com/Francois-Esquire/foundry/commit/3b37f85843407e3abb0c8aca4b90375f2a4bdcea))
* **memory:** added memory server ([2442ab0](https://github.com/Francois-Esquire/foundry/commit/2442ab075fc498bf106c7b786bd75f3e00eda813))
* modules in place ([77e8cc9](https://github.com/Francois-Esquire/foundry/commit/77e8cc92e5abc0d99b12c2b4673b90b4a8306d9e))
* **quirks:** copy app and supporting packages ([addb1fb](https://github.com/Francois-Esquire/foundry/commit/addb1fb5915f248201caba4f714f4dfa449e3401))
* **tests:** prototype introspection ([f05ac06](https://github.com/Francois-Esquire/foundry/commit/f05ac065131d06840a295db16bf7e3d6ea4cfed2))

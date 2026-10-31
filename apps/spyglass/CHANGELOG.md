# Changelog

## [0.0.3](https://github.com/Francois-Esquire/foundry/compare/spyglass-v0.0.2...spyglass-v0.0.3) (2026-10-31)


### Features

* **spyglass:** one GPU context for the chart ([#16](https://github.com/Francois-Esquire/foundry/issues/16)) ([497bac6](https://github.com/Francois-Esquire/foundry/commit/497bac6b00863da02d218f4cb7d6ae7f05c514bd))
* **spyglass:** rendering foundation, shared dependency foundations and the geology preview ([#22](https://github.com/Francois-Esquire/foundry/issues/22)) ([9b56c3a](https://github.com/Francois-Esquire/foundry/commit/9b56c3adf5f9d84f7189b1ef1515e3216a301b5a))
* **spyglass:** SDF trial: islands meshed by dual contouring in WebGPU compute ([#21](https://github.com/Francois-Esquire/foundry/issues/21)) ([2c682e5](https://github.com/Francois-Esquire/foundry/commit/2c682e53fa82445c863fd6c213e9ef545d82c3a2))
* **spyglass:** show scan progress live in the terminal ([#18](https://github.com/Francois-Esquire/foundry/issues/18)) ([c83be84](https://github.com/Francois-Esquire/foundry/commit/c83be847d11db73a40db248299e9059326d498c5))


### Bug Fixes

* correct edge cases across storage, process, parsing and tool handling ([#27](https://github.com/Francois-Esquire/foundry/issues/27)) ([23d01d0](https://github.com/Francois-Esquire/foundry/commit/23d01d0d52fd42b5193195bce7d12f24eb185cdc))

## [0.0.2](https://github.com/Francois-Esquire/foundry/compare/spyglass-v0.0.1...spyglass-v0.0.2) (2026-10-17)


### Bug Fixes

* **spyglass:** document the published alpha release flow ([2ad4f00](https://github.com/Francois-Esquire/foundry/commit/2ad4f00006e7d041e64412b1c7fe3ce3ff834efb))

## 0.0.1 (2026-10-17)


### Features

* **atlas:** add atlas apply ([cba611e](https://github.com/Francois-Esquire/foundry/commit/cba611e3419a572b2e25ed27ae583ee81047e32c))
* **atlas:** add the library serve and retire the second server ([630af14](https://github.com/Francois-Esquire/foundry/commit/630af140ddc6642f504958272f4a27fdf1929303))
* **atlas:** harden the mutator and preview an authorized plan ([4aa6b2a](https://github.com/Francois-Esquire/foundry/commit/4aa6b2a337f5a5ffc0fab52e61efd329b83f1b51))
* **atlas:** lock the state directory and keep a workspace record ([9408044](https://github.com/Francois-Esquire/foundry/commit/94080446cf2367207af2d495ea81dbf6da253401))
* **lib:** file-backed grant repository on the reference transitions ([a99b276](https://github.com/Francois-Esquire/foundry/commit/a99b27654c4a517ebb943640b5c2925e5d28c46f))
* **marbles,lib:** command steps and a body's exec ([aa34e6d](https://github.com/Francois-Esquire/foundry/commit/aa34e6d97ebb16e88eb716653456b48da1132c1c))
* **prompts:** add harness prompt dialects with live reference checks ([#10](https://github.com/Francois-Esquire/foundry/issues/10)) ([2fcbfa6](https://github.com/Francois-Esquire/foundry/commit/2fcbfa6071cc63b35dea9ffeffde5a6fde345cf6))
* **quirks:** copy app and supporting packages ([addb1fb](https://github.com/Francois-Esquire/foundry/commit/addb1fb5915f248201caba4f714f4dfa449e3401))
* **release:** queue protected publishing and prepare Spyglass alpha ([9698911](https://github.com/Francois-Esquire/foundry/commit/969891154d1e1559767039e48e64ce07b0cab99d))
* sync agent composition and workspace file creation ([7a2f752](https://github.com/Francois-Esquire/foundry/commit/7a2f752d86372eac6df74353ab4d0823bac52eb5))
* **workspaces:** adopt shared storage entries and align Quirks ([d936e5c](https://github.com/Francois-Esquire/foundry/commit/d936e5c8b333acd3742a869c1708f6eb91318b81))
* **workspaces:** drive Quirks monitoring through workspace change events ([31d7375](https://github.com/Francois-Esquire/foundry/commit/31d73756b5d1b4ffadbfdc09881454a83bdd716f))
* **workspaces:** support filesystem-resolved sources and load references ([8a20bfe](https://github.com/Francois-Esquire/foundry/commit/8a20bfed18fa3a44231feb7c17eede9b96e6d687))


### Bug Fixes

* **ci:** avoid expensive buffer assertions and retain bundled model types ([81b5790](https://github.com/Francois-Esquire/foundry/commit/81b579091fc1b4df7b80da81a416525370815a34))
* **lib:** harden the file lock against wedges, stray releases and racing breakers ([d249694](https://github.com/Francois-Esquire/foundry/commit/d249694d93ab37e8ec5a49a675993d463833b243))
* **lib:** share the queue and lock, pin grant schemas, flush directories ([6b9def0](https://github.com/Francois-Esquire/foundry/commit/6b9def0ae82b2af587869dff71ecf59c6526f10f))
* **spyglass:** unify source edits and harden dataset publication ([1af5229](https://github.com/Francois-Esquire/foundry/commit/1af5229bfdcb57772b736a2c31157f2ce601ecb2))

## 0.1.0 (2026-09-16)

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

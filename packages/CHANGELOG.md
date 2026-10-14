# Changelog

## 0.1.0 (2026-10-14)


### Features

* **agents,marbles:** pass structured output and model settings through agent turns ([10924f1](https://github.com/Francois-Esquire/foundry/commit/10924f1b907d0693b1b63505456a895ecd9345fb))
* **agents:** export capability schemas and session record builders ([08178cd](https://github.com/Francois-Esquire/foundry/commit/08178cd264c3d381411bade32f88959d9dfe95f2))
* **artifacts:** add JSON artifact store ([ad9bd84](https://github.com/Francois-Esquire/foundry/commit/ad9bd84e3ffcdca3b0737ed2c158d0c09c3ac16b))
* **artifacts:** add versioned artifact storage package ([4e6f196](https://github.com/Francois-Esquire/foundry/commit/4e6f19672622e81ead83f3e111f895c2662b82ee))
* **atlas:** add atlas apply ([cba611e](https://github.com/Francois-Esquire/foundry/commit/cba611e3419a572b2e25ed27ae583ee81047e32c))
* **atlas:** add the library serve and retire the second server ([630af14](https://github.com/Francois-Esquire/foundry/commit/630af140ddc6642f504958272f4a27fdf1929303))
* **atlas:** harden the mutator and preview an authorized plan ([4aa6b2a](https://github.com/Francois-Esquire/foundry/commit/4aa6b2a337f5a5ffc0fab52e61efd329b83f1b51))
* **atlas:** lock the state directory and keep a workspace record ([9408044](https://github.com/Francois-Esquire/foundry/commit/94080446cf2367207af2d495ea81dbf6da253401))
* **harness:** run coding agents in MicroSandbox ([1ef0f4f](https://github.com/Francois-Esquire/foundry/commit/1ef0f4f0e4be5bd819438513a6681687c440ec60))
* **lib:** file-backed grant repository on the reference transitions ([a99b276](https://github.com/Francois-Esquire/foundry/commit/a99b27654c4a517ebb943640b5c2925e5d28c46f))
* **marbles,agents:** skill files as bytes, skills defined in code, skills.none() ([858dd3a](https://github.com/Francois-Esquire/foundry/commit/858dd3a3eec046c4057d60591f7a89736f4162c2))
* **marbles,lib:** command steps and a body's exec ([aa34e6d](https://github.com/Francois-Esquire/foundry/commit/aa34e6d97ebb16e88eb716653456b48da1132c1c))
* **modules:** add the Artifact-backed Modules package ([02de36d](https://github.com/Francois-Esquire/foundry/commit/02de36d0337a97fefd3bc1c0018b017fc4bf9b98))
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
* **marbles:** harden run lifecycle and session contracts ([5fe38ac](https://github.com/Francois-Esquire/foundry/commit/5fe38acecab7f911bb19e764d2cf8178a07bd9ec))
* **models:** export every runtime module the docs promise ([9a52994](https://github.com/Francois-Esquire/foundry/commit/9a52994d6eae031ae6cb993454ba522bb9b1fcb2))
* **models:** keep kind defaults in step with registration ([eb7a768](https://github.com/Francois-Esquire/foundry/commit/eb7a768c4bbd50b6dac3badcd9962d564f5d4e62))
* **models:** validate settings where they enter and keep defaults across re-registration ([539da34](https://github.com/Francois-Esquire/foundry/commit/539da344efdab9ab34d967809fa345d9bd468cbd))
* **models:** validate the kind defaults settings route by ([588781e](https://github.com/Francois-Esquire/foundry/commit/588781e5f55e58c312fac6aa8183afa2888dc7dc))
* **sandbox:** resolve every process cwd alike, apply registry config, unify errors ([3ba0ce0](https://github.com/Francois-Esquire/foundry/commit/3ba0ce0ee639bdf0ef803a501f450a95ace23bc6))
* **workspaces:** refresh source after pending watcher scans ([2394604](https://github.com/Francois-Esquire/foundry/commit/2394604f42e440d5c4192e3a4aefe50e617da309))

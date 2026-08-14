# generated/kotlin — DO NOT HAND-EDIT

These Kotlin models are **generated**. They are produced by:

```bash
npm run models          # from packages/contracts — runs swift + kotlin
# or just this target:
npm run models:kotlin   # openapi-generator-cli -g kotlin → generated/kotlin
```

from `packages/contracts/openapi/openapi.v1.json`, which is itself generated
from the zod schemas in `packages/contracts/src/schemas/` (`npm run openapi`).

## Rules

- **Never edit anything in this directory by hand.** The next `npm run models`
  overwrites it, silently discarding your change.
- To change a model, edit the zod schema in `src/schemas/`, then run
  `npm run openapi && npm run models`.
- The Android app (`apps/android`) consumes these models. A change here is a
  three-client change — the same generation feeds `generated/swift` for iOS and
  the OpenAPI doc for web.

## Toolchain

`openapi-generator-cli` (the `@openapitools/openapi-generator-cli` npm wrapper)
with generator `kotlin`, `serializationLibrary=kotlinx_serialization`, package
`app.algominutes.api`. It requires a Java runtime on `PATH`. Generation is
scoped to models only (`--global-property=models`); the app owns its own
networking layer.

> This directory is committed so the models exist without a local codegen run.
> Codegen tooling is installed in a later build step (post-A4); until then, treat
> `openapi/openapi.v1.json` as the live contract.

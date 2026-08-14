# @algominutes/contracts

The AlgoMinutes API contract, authored **once**. zod schemas are the single
source of truth; the OpenAPI document and the Swift/Kotlin client models are
generated from them. We never hand-write three copies of a type.

## The rule

**A change here is a three-client change.** Every request/response shape lives
in `src/schemas/`. Editing one touches iOS, Android, and web at the same time —
which is the point: they cannot drift, because they are all generated from this
package.

When you change a schema:

```bash
npm run openapi   # regenerate openapi/openapi.v1.json from the zod schemas
npm run models    # regenerate generated/swift + generated/kotlin from that JSON
```

Both outputs are committed so the artifacts exist without a build. Never
hand-edit `openapi/openapi.v1.json` or anything under `generated/` — edit the
schemas and regenerate.

## Versioning — `/v1`, from day one

- Every route is mounted under `/v1` (`API_BASE_PATH` in `src/version.ts`).
- **A live version is never broken.** A breaking change ships as `/v2`; `/v1`
  keeps working for builds already in the field.
- Every client sends `X-AlgoMinutes-Client: <platform>/<semver>`
  (`CLIENT_VERSION_HEADER`). The api service checks it against
  `MIN_SUPPORTED_CLIENT` and refuses an unsupported build with a friendly
  "please update" (HTTP 426), never a 500.
- **iOS and web ship before Android, and old builds must keep working** — so the
  minimum-supported floor is only ever raised deliberately.

`src/version.ts` is the single source of truth for all of the above; the api
service imports it rather than re-declaring the version anywhere.

## Layout

```
src/
  version.ts          API_VERSION, header name, MIN_SUPPORTED_CLIENT, guards
  schemas/            one file per domain — the source of truth
  openapi.ts          projects the schemas into an OpenAPI v3 document
  index.ts            public entrypoint (@algominutes/contracts)
scripts/
  generate-openapi.ts the only writer of openapi/openapi.v1.json
openapi/
  openapi.v1.json     generated + committed
generated/
  swift/              generated + committed — never hand-edit (see its README)
  kotlin/             generated + committed — never hand-edit (see its README)
```

## Scripts

| script          | what it does                                                        |
| --------------- | ------------------------------------------------------------------- |
| `openapi`       | zod schemas → `openapi/openapi.v1.json`                              |
| `models`        | `openapi.v1.json` → Swift **and** Kotlin models                     |
| `models:swift`  | `openapi.v1.json` → `generated/swift/` (`swift5`)                    |
| `models:kotlin` | `openapi.v1.json` → `generated/kotlin/` (`kotlin`, kotlinx.serial.)  |
| `typecheck`     | `tsc --noEmit`                                                       |

> Codegen tooling (`tsx`, `@openapitools/openapi-generator-cli`) is installed in
> a later build step; until then the committed `openapi/openapi.v1.json` is the
> live artifact. `openapi-generator-cli` needs a JVM on `PATH`.

## Faithfulness

Schemas are ported verbatim from the wassup source shapes (Firestore `Note`,
the five function handlers, and the iOS models) — **field names are not
renamed** in this phase. Where a shape was ambiguous, the source Swift model's
shape was taken and a `// TODO(contracts):` note left in the schema file.

// @algominutes/contracts — the API contract, authored ONCE.
//
// A change in this package is a three-client change (iOS, Android, web) plus
// the api service. After editing a schema, run `npm run openapi && npm run
// models` so the OpenAPI doc and the generated Swift/Kotlin models stay in sync.
export * from './version';
export * from './schemas';

// The OpenAPI builder is exported for the api service (to serve /openapi.json)
// and for contract tests. The zod schemas remain the source of truth.
export { buildOpenApiDocument, buildRegistry, openApiInfo } from './openapi';

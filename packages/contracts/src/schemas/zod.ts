// The one place zod is extended with `.openapi()`.
//
// `@asteasolutions/zod-to-openapi` monkey-patches zod's prototype so schemas
// gain an `.openapi(refId?, metadata?)` method that the generator reads. That
// patch must run exactly once, and before any schema in this package is
// constructed — so every schema module imports `z` from HERE, never from
// `zod` directly. Importing from `zod` in a schema file would build a schema
// against the un-extended prototype and `.openapi(...)` would throw at load.
import { z } from 'zod';
import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';

extendZodWithOpenApi(z);

export { z };

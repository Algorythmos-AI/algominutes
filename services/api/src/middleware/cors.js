// The api's CORS: the one configuration every browser-facing service shares
// (@algominutes/ai/cors.cjs; billing uses it too). CLAUDE.md: never `cors: true`.
import corsModule from '@algominutes/ai/cors.cjs';

export const { buildAllowedOriginSet, buildCorsMiddleware } = corsModule;

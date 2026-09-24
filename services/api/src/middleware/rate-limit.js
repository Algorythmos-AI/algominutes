// Request rate limits: the shared implementation (@algominutes/ai/rate-limit.cjs),
// also used by services/billing.
import rateLimitModule from '@algominutes/ai/rate-limit.cjs';

export const { clientRateLimit, userRateLimit, trustProxyHops } = rateLimitModule;

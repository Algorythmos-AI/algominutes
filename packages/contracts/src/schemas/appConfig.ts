// GET /v1/config — server-side switches the apps read at launch, so a feature
// can be turned off without shipping a build.
import { z } from './zod';

export const AppConfigResponse = z
  .object({
    // The iOS "capture audio from another app" entry point (a broadcast
    // extension, the top App Review risk). false hides it.
    broadcastCapture: z.boolean(),
  })
  .openapi('AppConfigResponse');

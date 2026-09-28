// GET /v1/config — server-side switches the apps read at launch, so a feature
// can be turned off without shipping a build.
import { z } from './zod';
import { NotetakerSwitches } from './meetings';

export const AppConfigResponse = z
  .object({
    // The iOS "capture audio from another app" entry point (a broadcast
    // extension, the top App Review risk). false hides it.
    broadcastCapture: z.boolean(),
    // The online-meeting notetaker, per surface (docs/plans/MEETINGS.md).
    // Optional: an older server omits it, and absent means every one is off.
    notetaker: NotetakerSwitches.optional(),
  })
  .openapi('AppConfigResponse');

import fs from 'node:fs';
import path from 'node:path';

// Which build is in apps/site/dist. Production serves the "coming soon"
// placeholder at /app; staging (APP_ENABLED=true, scripts/build-site.mjs)
// serves the web app there. CI builds and tests both.
export const DIST = path.resolve('apps/site/dist');
export const APP = fs.existsSync(path.join(DIST, 'app/index.html'));

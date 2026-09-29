'use strict';

// A 2-hour chunk transcribes well inside an hour; 120 polls at 60s is a wide
// margin over that, and a bound the queue's own --max-attempts cannot provide
// because each poll mints a NEW task rather than retrying the old one. Shared
// with last-attempt.js, which tells an exhausted poll from a failing one.
const MAX_STT_POLLS = 120;

module.exports = { MAX_STT_POLLS };

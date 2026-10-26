# services/meetings

The online-meeting notetaker (`docs/plans/MEETINGS.md`): the only code that talks to Recall.ai.

- **`POST /webhooks/recall`** (public): Recall's signed webhooks, checked over the raw body (`src/lib/recall-signature.js`:
  every `v1` signature, two secrets during a rotation, ±5 min). Stored once per `webhook-id` and answered 2xx at once.
  Never a 4xx for a real delivery, because Svix disables an endpoint after 5 days of failures.
- **`POST /tasks/:kind`**: Cloud Tasks only. The service is public, so the app checks the OIDC token itself
  (`src/lib/task-auth.js`): Google-signed, for this exact URL, issued to `run-jobs`, email verified.
- **Recall's API key and webhook secret** are read from Secret Manager at run time (`recall-api-key`,
  `recall-webhook-secret`; the second may hold two values during a rotation). They aren't in the env, so a deploy never
  depends on them. Until they exist, the webhook answers 503 and the notetaker stays off (`/v1/config`).

One Recall account per environment, in ap-northeast-1 (Tokyo); Recall has no Australian region. The owner creates the
accounts and adds the secrets (`docs/BLOCKERS.md`, "Online meetings").

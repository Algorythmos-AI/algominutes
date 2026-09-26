# Runbook: prove staging from inside its VPC

Staging's Postgres has a private IP only, and its Vertex models are pinned to
Sydney. A laptop can't prove either, so a small **proof VM inside the VPC** does
(`infra/terraform/modules/environment/bastion.tf`, switched on by
`enable_bastion = true` in `envs/staging/main.tf`).

## What gets proven

`scripts/prove-staging.sh`, run on the VM, prints evidence for each check and
exits 0 only if all of them pass:

| Check | Proves |
|---|---|
| `tls-enforced` | Cloud SQL **refuses plaintext** (`ssl_mode = ENCRYPTED_ONLY`) |
| `tls-connect` | an encrypted session works (`pg_stat_ssl`: TLS version and cipher) |
| `extensions` | `vector`, `pg_trgm`, `uuid-ossp` are installed on Cloud SQL |
| `schema-at-head` | every migration at the proven commit is in `schema_migrations`, with a checksum |
| `integration` | the **full integration suite** (tenant isolation, idempotency, migrator, TLS pools) passes against **Cloud SQL itself**, over TLS, in a throwaway database |
| `cleanup` | that run left no throwaway databases behind (the app DB is never touched) |
| `vertex-smoke` | every active Gemini rung and the embedder answer **in australia-southeast1** with the summarizer's real schema and token budget (`finishReason STOP`) |

The deployed services are proven separately, by the deploy pipeline itself:
build → migrate → Vertex smoke → rollout → `scripts/smoke-staging.sh`, which
checks readiness over TLS, URL wiring and that workers are private.

## Run it

Prerequisites: signed in as `algorythmos.france@gmail.com` (the primary working account;
add `--account=algorythmos.france@gmail.com` to the `gcloud` commands), and staging applied with
`enable_bastion = true` (`terraform output bastion_ssh_command`).

```bash
gcloud compute ssh algominutes-staging-bastion --zone australia-southeast1-a \
  --project algominutes-staging --tunnel-through-iap \
  --command "PROOF_REF=integration bash -s" < scripts/prove-staging.sh
```

The first boot's startup script installs `psql`, `git`, `jq` and Node 24
(checksum-verified). Watch for it with:

```bash
gcloud compute ssh algominutes-staging-bastion --zone australia-southeast1-a \
  --project algominutes-staging --tunnel-through-iap \
  --command "sudo journalctl -t bastion-startup --no-pager | tail -5"
```

It's done when it logs `bastion-startup: ready`.

## Prove the rate limit keys on the real client IP (from your Mac)

The api trusts exactly `TRUST_PROXY_HOPS` proxies (default 1), because Cloud Run's front
end appends the real client address as the rightmost `X-Forwarded-For` entry. If that's
wrong, either spoofed headers get fresh buckets (too few hops) or every client shares one
bucket (too many). After a deploy, check it from outside. Rotate a spoofed leftmost entry
and expect `429` once the per-IP limit (300/min) is used up:

```bash
API=https://api-PROJECTNUMBER.australia-southeast1.run.app   # the deployed api URL
for i in $(seq 1 310); do curl -s -o /dev/null -w '%{http_code}\n' -H "X-Forwarded-For: 10.0.$((i/250)).$((i%250))" "$API/v1/shares/read" -X POST -H 'Content-Type: application/json' -d '{}'; done | sort | uniq -c
```

Pass: some `429`s appear, even though every request claimed a different IP. If there are
no `429`s, spoofing works and `TRUST_PROXY_HOPS` is too low. If `429`s also show up for a
second machine that sent nothing, all clients share a bucket and it's too high.

## Security

- **No inbound traffic** except SSH from Google's IAP range, and only to this VM.
  OS Login only; project SSH keys are blocked.
- **Its own service account** can read the one DB-password secret and call
  Vertex. Nothing else.
- **The external IP is for outbound installs only.** No ingress rule references it.
- The script reads connection facts from instance metadata. **The password comes
  from Secret Manager at run time** and is never written to disk or into URLs
  (`pg` reads `PGPASSWORD`).

## Remove it

Set `enable_bastion = false` in `envs/staging/main.tf` and apply. That deletes the
VM, its firewall rule, its service account and its IAM grants. It costs roughly
US$15/month while it exists.

## Rehearse off-VM

The `PROOF_*` environment overrides run the same script against a local Postgres,
reusing an existing checkout (`PROOF_REUSE_CHECKOUT=1`). There, `tls-enforced`
**must fail** (local Postgres accepts plaintext) and `vertex-smoke` **must fail**
(no staging access). That shows both checks can fail. The script only ever
deletes a work directory it created itself (it leaves a marker file there).

#!/usr/bin/env bash
# Make a beta invite code on this machine (docs/plans/RELEASE.md PR 2):
# BETA-XXXXX-XXXXX-XXXXX, 75 random bits in Crockford base32. Pass it to the
# db-job `beta-invite` handler, which stores only its hash, then send it to the
# tester yourself. The code isn't written anywhere else.
#
#   scripts/new-invite-code.sh    # prints a code, its hash and the command to register it
set -euo pipefail

ALPHABET='0123456789ABCDEFGHJKMNPQRSTVWXYZ'   # Crockford: no I, L, O or U
chars=''
# 32 divides 256, so byte % 32 is uniform.
for byte in $(od -An -N15 -tu1 /dev/urandom); do
  chars+="${ALPHABET:$((byte % 32)):1}"
done
code="BETA-${chars:0:5}-${chars:5:5}-${chars:10:5}"
# The db-job gets only this: the SHA-256 of the canonical code.
if command -v shasum >/dev/null; then sha=(shasum -a 256); else sha=(sha256sum); fi
hash=$(printf '%s' "$code" | "${sha[@]}" | cut -d' ' -f1)

cat <<OUT
Code (send this to the tester; it isn't stored anywhere):
  $code
Register it on staging (only the hash leaves this machine; the label is yours):
  gcloud run jobs execute db-job --region australia-southeast1 --project algominutes-staging \\
    --account=algorythmos.france@gmail.com --wait \\
    --update-env-vars "JOB_NAME=beta-invite,INVITE_CODE_SHA256=$hash,INVITE_LABEL=cohort 1,INVITE_USES=25,INVITE_DAYS=30"
Optional: INVITE_MINUTES=600, INVITE_NOTETAKER=true, INVITE_EXPIRES_DAYS=14.
List:   JOB_NAME=beta-invite,MODE=list
Revoke: JOB_NAME=beta-invite,MODE=revoke,INVITE_ID=<id from the list>
OUT

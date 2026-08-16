# Vendor data-retention & training findings — AssemblyAI vs Deepgram

**Purpose.** Residency obligation #1 of the diarisation run: confirm and document the STT vendor's audio
retention policy — "processed then deleted" (defensible) vs "retained for training" (not) — so the store
declarations and the APP 8 cross-border disclosure are based on fact, not assumption.

**Research date:** 2026-08-16. All quotes are from official vendor sources; dates noted where disclosed.
This is the evidence behind the DECISIONS.md "Diarisation" entry and the BLOCKERS opt-out/DPA items.

---

## AssemblyAI (PRIMARY engine)

### Verdict
**Processed-then-deleted by default — BUT customer data is used for model training by default (opt-out),
and free-tier accounts cannot opt out.** These are two separate controls: deletion is the default;
training-exclusion is not.

### Retention / auto-deletion (async transcription)
Source: AssemblyAI Support — "Does AssemblyAI offer zero data retention?" (page last updated ~late 2025)
<https://support.assemblyai.com/articles/2240096256-does-assemblyai-offer-zero-data-retention>
- Async default: **"Default deletion process begins at 72 hours (or can be set to as low as 1-hour)"** via a
  configurable TTL.
- Uploaded audio: **"Deletion process begins at 24 hours and is at most 48 hours."**
- Streaming: **"zero data retention of audio and transcripts for our Streaming product"** (we use async).
- Certain metadata is retained **"for logging and billing purposes"** after audio/transcript deletion.
- Immediate deletion is also available via the DELETE transcript API —
  <https://www.assemblyai.com/docs/pre-recorded-audio/delete-transcripts> (this is what `deleteRemote` calls).

### Model training on customer data (default = must opt out)
Sources:
<https://www.assemblyai.com/docs/faq/how-to-opt-out-of-data-sharing-for-our-model-improvement-program>,
<https://support.assemblyai.com/articles/5930031898-how-to-opt-out-of-data-sharing-for-model-training>
- Default is **opt-in** (Terms of Service §4.3(b)(iii)). After opting out: **"AssemblyAI will not use your
  Customer Data to train its artificial intelligence and machine learning models."**
- Mechanism: paid customers opt out **self-serve from the Data Controls page** or by emailing
  **data-opt-out@assemblyai.com**.
- **"Free users do not have the ability to opt out of the model improvement program."**
- **"Opt-out requests are forward-looking only"** (not retroactive).
- Opting out **forgoes the discounts** on the pricing page.

### Geography / DPA / compliance
Sources: <https://www.assemblyai.com/security>, DPA (effective **2026-01-22**)
<https://www.assemblyai.com/legal/data-processing-addendum>
- DPA: **"AssemblyAI's primary processing operations take place in the United States."**
- EU option exists: **"Customers can store and process their data within the United States or the European
  Union"** (European processing centre in Dublin, Ireland). US is our decision; EU is a residency seam.
- Executed DPA incorporating **EU SCCs** + the **Data Privacy Framework**; **SOC 2 Type 1 & Type 2**;
  **AES-256 at rest, TLS 1.3 in transit**; PCI-DSS L1; BAA/HIPAA path available.

### What this obliges us to do (wired + tracked)
1. **Use a PAID account and opt out of the model-improvement program** (account-level; free tier can't).
   → BLOCKERS `TODO(ops)`.
2. **Execute the AssemblyAI DPA** before production audio flows. → BLOCKERS `TODO(legal)`.
3. **Delete each transcript after persisting** — done in code (`assemblyai.deleteRemote`), vendor TTL is the
   backstop. Consider setting the account TTL to the 1-hour minimum.

---

## Deepgram (FAILOVER seam)

### Verdict
**Processed-then-deleted for opted-out requests — but the hosted/pay-as-you-go API is enrolled in model
training by default (opt-out per request via `mip_opt_out=true`).** We set `mip_opt_out=true` on every
request (see `providers/deepgram.js` `buildQuery`).

### Retention / training
Source: Deepgram Model Improvement Partnership Program (undated)
<https://developers.deepgram.com/docs/the-deepgram-model-improvement-partnership-program>
- **"The only data we will store and use in future model training is the data that is contractually included
  through participation in the … Model Improvement Partnership Program."**
- Opt-out: **"Add `mip_opt_out=true` as a query parameter of all API requests that you want to be excluded."**
- Opted-out retention: **"Data from opted-out requests is retained only for the duration necessary to process
  the request."** (Effectively zero-retention for opted-out traffic.)

### Geography / compliance
Sources: <https://developers.deepgram.com/trust-security/data-privacy-compliance>,
Privacy Policy (Last Updated **2021-10-26**) <https://deepgram.com/privacy>
- **"We store data on servers in the U.S."** EU endpoint `api.eu.deepgram.com` and an in-country Australia
  endpoint exist. GDPR "ready"; **SOC 2 Type 1 & 2**; BAA on request.

---

## Side-by-side

| | AssemblyAI (async) | Deepgram (hosted API) |
|---|---|---|
| Audio deleted after processing? | Yes — default 72h, TTL to 1h; uploads 24–48h | Only for opted-out requests ("duration necessary to process") |
| Trains on customer data by default? | **Yes (opt-in default; must opt out)** | **Yes on pay-as-you-go (opt-out via `mip_opt_out=true`)** |
| Opt-out available? | Paid: dashboard/email. **Free: no** | Per-request param; forfeits discount |
| Configurable delete-after-N-hours? | **Yes — TTL to 1h** | No TTL control; opt-out gives zero-retention |
| US processing / EU option | US primary / EU (Dublin) | US default / EU + AU endpoints |
| DPA | Executed (2026-01-22), SCCs, DPF | GDPR "ready"; BAA on request; privacy policy dated 2021 |
| SOC 2 | Type 1 + Type 2 | Type 1 + Type 2 |

---

## Could NOT fully verify (do not summarise away)

1. **Deepgram's "opt-in by default" is inferred, not verbatim.** The MIP doc reads opt-in, but the existence
   of `mip_opt_out=true` + the discount imply pay-as-you-go is enrolled-by-default. The explicit sentence is
   from secondary sources, not a quotable official line. Confirm in Deepgram's ToS/order form before relying
   on it in a legal record.
2. **Deepgram privacy policy is stale (2021-10-26)** and silent on model training; operative terms live in
   undated developer docs. For a compliance record, get the dated contractual source (MSA/DPA/order form).
3. **Deepgram public DPA with SCC module language not retrieved** (behind "contact us") — weaker/vaguer than
   AssemblyAI's executed, dated DPA.
4. **AssemblyAI async-retention page shows only a relative date** ("~8 months ago"); the DPA has a firm date.

Since Deepgram is the off-by-default failover that already exceeds Pro revenue, its residual DPA ambiguity is
not blocking for launch — AssemblyAI is the engine whose DPA + opt-out must be executed.

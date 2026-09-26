# STORE-LISTING — App Store & Play Store Listing Plan (A10 #6)

> Launch-blocker artifact. The store listing is **distribution**, not decoration — it is the
> single highest-leverage conversion surface we own. Publisher: **Algorythmos Pty Ltd**
> (Sydney, AU), shipping globally. All imagery is `TODO(brand)`; this doc is the copy +
> plan. App name working assumption: **AlgoMinutes**.

---

## 1. Keyword research (title + subtitle)

### 1.1 How the stores use text (why placement matters)
- **Apple:** ranking weight comes from the **app name (30 chars)**, **subtitle (30 chars)**,
  and the hidden **keywords field (100 chars, comma-separated, no spaces)**. The long
  description is **not** indexed for search. So the name + subtitle + keyword field must
  carry all the SEO.
- **Google Play:** the **title (30 chars)**, **short description (80 chars)**, and **long
  description (4000 chars)** are **all** indexed. Repeating key terms naturally in the long
  description helps on Play (but don't keyword-stuff — Play penalises it).

### 1.2 Candidate keywords (with reasoning)

| Keyword / phrase | Why it earns a slot |
|---|---|
| **meeting recorder** | Primary category term; high intent; matches the core action. |
| **AI notes / AI meeting notes** | Captures the "summarise for me" value; "AI" is a strong 2025-era discovery term. |
| **transcribe / transcription** | High-volume utility search; people search the verb. |
| **voice recorder** | Broad top-of-funnel; many users start from "voice recorder" then discover AI. |
| **meeting summary / summarizer** | Matches the differentiator (summary output leads the app). |
| **action items** | Long-tail, high-intent for the "get tasks out of a meeting" job. |
| **audio to text / speech to text** | Utility phrasing some users default to. |
| **note taker / notetaker** | "AI notetaker" is a recognised product category now. |
| **interview / lecture / standup** | Use-case long-tails matching the shipped templates (A6.1). |
| **record calls / call recorder** | High intent — but `TODO(legal)`: only use if consent/policy posture supports promoting call recording; may attract store scrutiny. |

**Deliberately NOT chasing:** competitor brand names (Apple/Play both reject brand-term
targeting), and "free" as a keyword (weak, and interacts with the reverse-trial messaging).

### 1.3 Recommended title + subtitle

- **Apple app name (≤30):** `AlgoMinutes: AI Meeting Notes` (28)
- **Apple subtitle (≤30):** `Record, transcribe, summarise` (29)
- **Apple keywords field (≤100 characters, commas, no spaces after them):**
  `transcription,voice recorder,notetaker,action items,speech to text,minutes,lecture,interview`
  (92 characters). No word from the name or subtitle (AI, meeting, notes, record, transcribe, summarise):
  Apple already indexes those, so repeating them wastes the field.
- **Play title (≤30):** `AlgoMinutes: AI Meeting Notes` (28)
- **Play short description (≤80):**
  `Record meetings, get instant AI transcripts, summaries and action items.` (73)
- `TODO(brand):` Confirm the brand lockup / whether the subtitle should carry a tagline vs
  pure keywords. Copy above optimises for search; brand may want one word of personality.
- `TODO(legal):` Confirm "AI Meeting Notes" and any "record calls" phrasing are safe given
  the consent posture (CONSENT.md) — avoid implying unattended/covert recording.

---

## 2. Screenshot plan (~6) — LEAD WITH THE OUTPUT, not the record button

**Principle:** users don't want to record — they want the *result*. The first 1–2
screenshots (the only ones most people see) must show the **summary output: decisions and
action items**, framed with a benefit caption. The record button comes late.

All imagery `TODO(brand)`; captions below are the copy.

1. **The payoff — summary with decisions & action items.**
   Shows a finished note: a tidy summary, a **Key Decisions** block, and a checked
   **Action Items** list. Caption: **"Every meeting, summed up — decisions and action
   items, done for you."** This is the hero; it must read at thumbnail size.

2. **Action items you can actually act on.**
   Close-up of extracted action items (owner + task). Caption: **"Turn talk into a
   to-do list, automatically."**

3. **Searchable, accurate transcript.**
   The full transcript view with a search highlight. Caption: **"A full transcript you can
   search — find any moment in seconds."**

4. **Templates for how you meet.**
   The template picker (standup, interview, sales call, lecture, one-on-one, board meeting
   — from A6.1). Caption: **"Summaries tuned to your kind of meeting."**

5. **One tap to record — with consent built in.**
   NOW the record flow: the "Ready to record?" / consent sheet. Caption: **"Start in one
   tap. Everyone's kept in the loop."** (Doubles as a store-review signal that consent is
   front-and-centre.)

6. **Yours, everywhere / private by design.**
   Search and chat across every note + a privacy line. Caption: **"Ask any meeting a
   question. No ads, no tracking."** (The web app isn't shipped, so no cross-device claim;
   "no tracking" is true: nothing is shared with third parties for advertising.)

- `TODO(brand):` Device frames, real-looking (non-PII) sample content, light/dark variants,
  and localized text overlays. iOS: the 6.9" set (1320 × 2868), which App Store Connect scales for
  smaller iPhones; the app is iPhone-only, so no iPad set. Play: phone + 7"/10" tablet.

---

## 3. Demo video outline (30s)

Goal: show **result-first**, then how easy it is to get there. `TODO(brand)` for all
footage/VO.

- **0–3s — Hook (the result):** Full-screen finished summary with action items sliding in.
  On-screen text: *"Your meetings, summarised."*
- **3–8s — The problem it kills:** Quick shot of someone in a call; text: *"Stop taking
  notes."*
- **8–15s — One-tap capture + consent:** Tap record → the consent sheet → recording
  indicator. Text: *"Record in a tap — everyone in the loop."*
- **15–23s — The magic:** Processing → transcript appears → summary + decisions + action
  items populate. Text: *"AI writes the transcript, summary and to-dos."*
- **23–28s — Ask + private:** Ask the note a question in chat; text: *"Ask any meeting. No ads,
  no tracking."*
- **28–30s — CTA / logo:** `TODO(brand)` logo + *"AlgoMinutes"* + app-store badges.
- Constraints: readable **muted** (most previews autoplay silent — burn in captions);
  first 3s must stand alone; keep to the store's ≤30s app-preview limit.

---

## 4. Ratings-prompt rule

- **Trigger the OS review prompt only after a SUCCESSFUL summary** — i.e. a note reaches the
  `ready` state and the user has *viewed* the summary (a moment of realised value). This is
  where satisfaction peaks and ratings are highest-quality.
- **Never on launch, never during onboarding, never after a failure/error**, and never on a
  guest's first-ever session before they've seen a result.
- **Respect frequency limits:** use the native API (`SKStoreReviewController` /
  `requestReview` on iOS, Play In-App Review on Android) which self-throttles; additionally
  gate on our side — e.g. only after **≥1 successful summary** and **not more than once per
  long interval**. Never show a custom "rate us" wall that circumvents OS throttling
  (Apple/Play both disallow that).
- `TODO(eng):` Implement the client hook at the summary-`ready` view; store a "prompted"
  flag so guests and returning users aren't re-prompted improperly.

---

## 5. App Store description (Apple)

### 5.1 Promotional text (≤170, updatable without review)
> New: meeting templates for standups, interviews, sales calls and lectures — summaries
> tuned to how you actually meet.

### 5.2 Long description
> **AlgoMinutes turns your meetings into decisions and action items — automatically.**
>
> Hit record and get back a clean summary, the key decisions, and a ready-to-go action
> list. No more scrambling to take notes while trying to stay in the conversation.
>
> **What you get**
> - **Instant summaries** — the gist of any meeting, in seconds.
> - **Action items, extracted** — who's doing what, pulled out for you.
> - **Key decisions, captured** — the calls that were made, in one place.
> - **A searchable transcript** — find any moment without scrubbing audio.
> - **Templates** — standup, interview, sales call, lecture, one-on-one, board meeting and
>   more, each tuned for a better summary.
> - **Record what matters** — capture from your microphone, or the audio of a call.
> - **Ask your notes** — search every meeting, or ask one a question.
>
> **Private by design**
> - **No ads. No tracking.** Your recordings are yours.
> - Delete any note — or your whole account — whenever you want.
> - A clear, plain-English notice before every recording, so everyone's in the loop.
>
> Start free and see your first summary in minutes.
>
> `TODO(legal):` Final Terms & Privacy links. `TODO(brand):` tagline line.

---

## 6. Google Play description

### 6.1 Short description (≤80)
> Record meetings, get instant AI transcripts, summaries and action items.

### 6.2 Long description (≤4000)
> **AlgoMinutes records your meetings and gives you back the part that matters: a summary,
> the decisions, and a clear list of action items.**
>
> Stop taking notes. Tap record, and let AlgoMinutes write the transcript, summarise the
> conversation, and pull out who agreed to do what.
>
> **Why people use AlgoMinutes**
> - ⚡ **Instant AI summaries** of any meeting or voice note.
> - ✅ **Automatic action items** — turn talk into a to-do list.
> - 📌 **Key decisions** captured in one place.
> - 🔎 **Searchable transcripts** — jump to any moment.
> - 🎛️ **Meeting templates** — standups, interviews, sales calls, lectures, one-on-ones,
>   board meetings and more.
> - 🎙️ **Flexible recording** — your microphone, or the audio from a call.
> - 💻 **Record on mobile, review on the web** — your notes follow you.
>
> **Private by design**
> - No ads and no third-party tracking.
> - Delete a note or your entire account at any time — including from the web.
> - A plain-English notice appears before every recording, and you confirm you have
>   permission to record.
>
> Great for teams, freelancers, students, and anyone who's tired of writing up meetings.
> Start free and get your first summary today.
>
> `TODO(legal):` Terms, Privacy Policy, and the account-deletion URL
> (`docs/STORE-COMPLIANCE.md` §6.2). `TODO(brand):` feature-graphic + icon.

---

## 7. Open-items summary

| Item | Type |
|---|---|
| All screenshots, feature graphic, icon, app preview video, device frames (§2, §3) | `TODO(brand)` — blocking listing |
| Final title/subtitle personality vs pure-keyword (§1.3) | `TODO(brand)` |
| "AI Meeting Notes" / "record calls" phrasing vs consent posture (§1) | `TODO(legal)` |
| Terms + Privacy links, deletion URL in descriptions (§5, §6) | `TODO(legal)` |
| Ratings-prompt client hook at summary-`ready` (§4) | Eng |

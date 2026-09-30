import { describe, it, expect } from 'vitest';
import { MODULE, read, stripComments } from './helpers/terraform';

// RELEASE.md rev 11, N2 (H10). Speech-to-Text v2's batchRecognize fetches each gs:// chunk as Google's speech
// service agent (service-{project number}@gcp-sa-speech), not as run-transcoder. Nothing granted it the
// recordings bucket, where the transcoder writes its chunks, so every recording over 10 minutes would have
// failed at transcription. Probed on staging 2026-10-01: "Service account service-627101926311@gcp-sa-speech
// … does not have storage.objects.get access". The long path had never run there, so nothing had noticed.
const tf = stripComments(read(`${MODULE}/speech.tf`));
const cloudRun = stripComments(read(`${MODULE}/cloud-run.tf`));

describe("speech-to-text's access and location", () => {
  it("the speech service agent may read the transcoder's chunks, and nothing else in the bucket", () => {
    const grant = /resource "google_storage_bucket_iam_member" "speech_reads_chunks" \{([\s\S]*?)\n\}/.exec(tf)![1];
    expect(grant).toMatch(/bucket\s*=\s*google_storage_bucket\.buckets\["recordings"\]\.name/);
    expect(grant).toMatch(/role\s*=\s*"roles\/storage\.objectViewer"/);
    expect(grant).toMatch(/member\s*=\s*"serviceAccount:service-\$\{var\.project_number\}@gcp-sa-speech\.iam\.gserviceaccount\.com"/);
    expect(grant).toMatch(/objects\/transcoder\//);
  });

  it('the chunks it reads are the ones the transcoder writes', () => {
    const handler = read('services/transcoder/src/handler.js');
    expect(handler).toContain('const gcsPath = `transcoder/${noteId}/chunk-${slice.idx}.flac`;');
  });

  it('the transcoder runs speech-to-text in the region, with the one English Sydney offers for `long`', () => {
    const env = /transcoder\s*=\s*merge\(([^\n]*)\)/.exec(cloudRun)![1];
    expect(env).toMatch(/STT_LOCATION\s*=\s*var\.region/);
    expect(env).toMatch(/LANGUAGE_CODES\s*=\s*"en-AU"/);
  });
});

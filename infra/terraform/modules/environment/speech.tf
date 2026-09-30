# Speech-to-Text v2 (the transcoder's path for recordings over 10 minutes). batchRecognize fetches each
# gs:// chunk itself, as Google's speech service agent, not as run-transcoder. Nothing granted that agent the
# recordings bucket, where the transcoder writes its chunks, so every long recording would have failed at
# transcription: "service-<number>@gcp-sa-speech … does not have storage.objects.get access" (probed on
# staging 2026-10-01; RELEASE.md rev 11, N2). It may read the chunk folder and nothing else.
#
# The agent is named by project number. On staging it exists (the probe's error names it); a brand-new
# project creates it the first time the API is used, so on prod plan this after one speech call, or add a
# google_project_service_identity once it's verified for speech.googleapis.com.
resource "google_storage_bucket_iam_member" "speech_reads_chunks" {
  bucket = google_storage_bucket.buckets["recordings"].name
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:service-${var.project_number}@gcp-sa-speech.iam.gserviceaccount.com"

  condition {
    title       = "transcoder-chunks-only"
    description = "The FLAC chunks the transcoder writes for speech-to-text (transcoder/{noteId}/chunk-N.flac)"
    expression  = "resource.name.startsWith(\"projects/_/buckets/${google_storage_bucket.buckets["recordings"].name}/objects/transcoder/\")"
  }
}

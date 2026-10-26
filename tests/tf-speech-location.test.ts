import { describe, it, expect } from 'vitest';
import { MODULE, read, stripComments } from './helpers/terraform';

// RELEASE.md rev 11, N2. #297 moved speech-to-text to Sydney in Terraform (STT_LOCATION, en-AU) and granted
// Google's speech agent the chunk folder, on a probe that ran as a user account and couldn't read the file.
// The transcoder, as its own service account, reads its chunks fine on the global endpoint: a 15-minute e2e
// went through the long path end to end (run 36742160404). So the grant wasn't needed, and Sydney isn't proven
// for the transcoder's identity. Until it is, Terraform keeps the proven path.
const cloudRun = stripComments(read(`${MODULE}/cloud-run.tf`));

describe("speech-to-text's location", () => {
  it('stays on the proven global endpoint, with its three Englishes, until Sydney is proven as the transcoder', () => {
    const env = /transcoder\s*=\s*merge\(([^\n]*)\)/.exec(cloudRun)![1];
    expect(env).not.toMatch(/STT_LOCATION/);
    expect(env).toMatch(/LANGUAGE_CODES\s*=\s*"en-US,en-GB,en-AU"/);
  });

  it('grants the speech agent nothing: the transcoder reads its own chunks', () => {
    expect(() => read(`${MODULE}/speech.tf`)).toThrow();
  });
});

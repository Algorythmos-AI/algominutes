import { describe, it, expect } from 'vitest';
import {
  CreateUploadSessionRequest,
  RegisterPushTokenRequest,
  ClientPlatformSchema,
} from '@algominutes/contracts/schemas';
import { buildOpenApiDocument } from '@algominutes/contracts';

// The contract is authored once here and generated into three clients, so its
// schemas must accept valid payloads, reject malformed ones, and still assemble
// a well-formed OpenAPI document.
describe('contract schemas', () => {
  it('CreateUploadSessionRequest accepts a valid body', () => {
    const parsed = CreateUploadSessionRequest.parse({
      noteId: 'n1',
      workspaceId: 'w1',
      fileName: 'meeting.m4a',
      contentType: 'audio/mp4',
      totalBytes: 57_000_000,
    });
    expect(parsed.sha256).toBeUndefined();
    expect(parsed.totalBytes).toBe(57_000_000);
  });

  it('CreateUploadSessionRequest rejects a negative byte count', () => {
    const r = CreateUploadSessionRequest.safeParse({
      noteId: 'n1',
      workspaceId: 'w1',
      fileName: 'x',
      contentType: 'audio/mp4',
      totalBytes: -1,
    });
    expect(r.success).toBe(false);
  });

  it('RegisterPushTokenRequest rejects an unknown platform', () => {
    expect(RegisterPushTokenRequest.safeParse({ token: 't', platform: 'blackberry' }).success).toBe(false);
    expect(RegisterPushTokenRequest.safeParse({ token: 't', platform: 'ios' }).success).toBe(true);
  });

  it('ClientPlatformSchema enumerates exactly the three clients', () => {
    expect(ClientPlatformSchema.options).toEqual(['ios', 'android', 'web']);
  });
});

describe('OpenAPI document', () => {
  it('builds a 3.0.x document with component schemas and paths', () => {
    const doc = buildOpenApiDocument() as {
      openapi: string;
      paths: Record<string, unknown>;
      components?: { schemas?: Record<string, unknown> };
    };
    expect(doc.openapi).toMatch(/^3\./);
    expect(Object.keys(doc.paths).length).toBeGreaterThan(0);
    expect(Object.keys(doc.components?.schemas ?? {}).length).toBeGreaterThan(0);
  });
});

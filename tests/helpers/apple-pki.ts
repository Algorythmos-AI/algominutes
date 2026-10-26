import { execFileSync } from 'node:child_process';
import { X509Certificate, sign } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// A throwaway PKI built with openssl that stands in for Apple's (Apple Root CA - G3, the App Store
// intermediate and leaf, with Apple's marker extensions), so an Apple-signed JWS can be made in a test and
// verified against `root` (services/billing/src/lib/apple.js takes it as an option). Also a second root and
// a leaf without the App Store marker, for the refusals.

const CA = ['basicConstraints=critical,CA:TRUE', 'keyUsage=critical,keyCertSign,cRLSign'];
const INTERMEDIATE = [...CA, '1.2.840.113635.100.6.2.1=ASN1:NULL'];
const LEAF = ['basicConstraints=critical,CA:FALSE', 'keyUsage=critical,digitalSignature', '1.2.840.113635.100.6.11.1=ASN1:NULL'];

export const b64u = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');

export interface ApplePki {
  root: X509Certificate;
  /** A JWS signed by `leafName`'s key, carrying the chain `chain` (x5c). */
  jws: (payload: unknown, opts?: { leafName?: string; chain?: string[]; alg?: string }) => string;
  cleanup: () => void;
}

export function makeApplePki(): ApplePki {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apple-pki-'));
  const openssl = (...args: string[]) => execFileSync('openssl', args, { cwd: dir, stdio: 'pipe' });
  const der = (pemFile: string) => new X509Certificate(fs.readFileSync(path.join(dir, pemFile))).raw.toString('base64');
  const reqConfig = (name: string, ext: string[]) => {
    const f = path.join(dir, `${name}.cnf`);
    fs.writeFileSync(f, `[req]\ndistinguished_name=dn\n[dn]\n[v3]\n${ext.join('\n')}\n`);
    return f;
  };
  /** A CA or leaf certificate signed by `issuer` (none: self-signed), with the given extensions. */
  const cert = (name: string, issuer: string | null, ext: string[]) => {
    openssl('ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', `${name}.key`);
    fs.writeFileSync(path.join(dir, `${name}.ext`), `${ext.join('\n')}\n`);
    if (!issuer) {
      openssl('req', '-x509', '-new', '-key', `${name}.key`, '-subj', `/CN=${name}`, '-days', '3650', '-out', `${name}.pem`, '-extensions', 'v3', '-config', reqConfig(name, ext));
      return;
    }
    openssl('req', '-new', '-key', `${name}.key`, '-subj', `/CN=${name}`, '-out', `${name}.csr`);
    openssl('x509', '-req', '-in', `${name}.csr`, '-CA', `${issuer}.pem`, '-CAkey', `${issuer}.key`, '-CAcreateserial', '-days', '3650', '-extfile', `${name}.ext`, '-out', `${name}.pem`);
  };
  cert('root', null, CA);
  cert('int', 'root', INTERMEDIATE);
  cert('leaf', 'int', LEAF);
  cert('plainleaf', 'int', ['basicConstraints=critical,CA:FALSE']); // no App Store marker
  cert('other', null, CA); // another root
  cert('otherint', 'other', INTERMEDIATE);
  cert('otherleaf', 'otherint', LEAF);
  return {
    root: new X509Certificate(fs.readFileSync(path.join(dir, 'root.pem'))),
    jws(payload, { leafName = 'leaf', chain = ['leaf', 'int', 'root'], alg = 'ES256' } = {}) {
      const head = b64u({ alg, x5c: chain.map((n) => der(`${n}.pem`)) });
      // Signed now, as Apple stamps it: after the certificates were made (a payload may set its own).
      const body = b64u({ signedDate: Date.now(), ...(payload as object) });
      const sig = sign('sha256', Buffer.from(`${head}.${body}`), { key: fs.readFileSync(path.join(dir, `${leafName}.key`)), dsaEncoding: 'ieee-p1363' }).toString('base64url');
      return `${head}.${body}.${sig}`;
    },
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

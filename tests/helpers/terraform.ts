// A small reader for the parts of infra/terraform the contract tests check
// (tf-env-contract, tf-iam-contract). Not a general HCL parser: it reads the
// shapes this repo writes (maps of `KEY = expr`, `merge(...)`, `concat(...)`),
// and each test fails loudly if a shape it expects is missing.
import fs from 'node:fs';

export const MODULE = 'infra/terraform/modules/environment';
export const ENVS = ['staging', 'prod'] as const;
export type Env = (typeof ENVS)[number];

const cache = new Map<string, string>();
/** A repo file's text, read once per run. */
export const read = (p: string) => {
  if (!cache.has(p)) cache.set(p, fs.readFileSync(p, 'utf8'));
  return cache.get(p)!;
};

/** Drops `#` and `//` comments outside string literals, line by line. */
export function stripComments(src: string): string {
  return src
    .split('\n')
    .map((line) => {
      let inStr = false;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (c === '"' && line[i - 1] !== '\\') inStr = !inStr;
        if (!inStr && (c === '#' || (c === '/' && line[i + 1] === '/'))) return line.slice(0, i);
      }
      return line;
    })
    .join('\n');
}

/** The text between the bracket at `open` and its match (exclusive). */
export function balanced(src: string, open: number): string {
  const pairs: Record<string, string> = { '{': '}', '(': ')', '[': ']' };
  const stack: string[] = [];
  let inStr = false;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '"' && src[i - 1] !== '\\') inStr = !inStr;
    if (inStr) continue;
    if (pairs[c]) stack.push(pairs[c]);
    else if (c === stack[stack.length - 1]) {
      stack.pop();
      if (stack.length === 0) return src.slice(open + 1, i);
    }
  }
  throw new Error(`unbalanced bracket at ${open}`);
}

/** The body of `name = {` (a map in a locals block or a module call). */
export function mapBody(src: string, name: string): string {
  const m = new RegExp(`(^|\\n)\\s*${name}\\s*=\\s*\\{`).exec(src);
  if (!m) throw new Error(`no "${name} = {" block`);
  return balanced(src, m.index + m[0].length - 1);
}

/**
 * Top-level `key = expr` entries of a map body. An expression runs to the end
 * of its line at bracket depth 0, so a multi-line `merge(...)` and a whole
 * ternary (`f(x) ? { K = v } : {}`) are each one expression, never read as
 * entries of their own.
 */
export function entries(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  const src = stripComments(body);
  const key = /^\s*("?[\w-]+"?)\s*=(?!=)\s*/;
  let i = 0;
  while (i < src.length) {
    const nl = src.indexOf('\n', i);
    const lineEnd = nl === -1 ? src.length : nl;
    const m = key.exec(src.slice(i, lineEnd));
    if (!m) {
      i = lineEnd + 1;
      continue;
    }
    // Scan the value to the first newline outside brackets and strings.
    let j = i + m[0].length;
    const start = j;
    let depth = 0;
    let inStr = false;
    for (; j < src.length; j++) {
      const c = src[j];
      if (c === '"' && src[j - 1] !== '\\') inStr = !inStr;
      if (inStr) continue;
      if ('{(['.includes(c)) depth++;
      else if ('})]'.includes(c)) depth--;
      else if (c === '\n' && depth === 0) break;
    }
    out[m[1].replace(/"/g, '')] = src.slice(start, j).trim();
    i = j + 1;
  }
  return out;
}

/** The `{ ... }` map literals and `local.X` references merged by `merge(...)`, or a single one. */
export function mergeParts(expr: string): string[] {
  const e = expr.trim();
  if (!e.startsWith('merge(')) return [e];
  const inner = balanced(e, e.indexOf('('));
  const parts: string[] = [];
  let depth = 0;
  let inStr = false;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c === '"' && inner[i - 1] !== '\\') inStr = !inStr;
    if (inStr) continue;
    if ('{(['.includes(c)) depth++;
    else if ('})]'.includes(c)) depth--;
    else if (c === ',' && depth === 0) {
      parts.push(inner.slice(start, i).trim());
      start = i + 1;
    }
  }
  const last = inner.slice(start).trim();
  if (last) parts.push(last);
  return parts;
}

/** A root module's `module "environment" { ... }` arguments. */
export function moduleArgs(env: Env): Record<string, string> {
  const src = read(`infra/terraform/envs/${env}/main.tf`);
  const m = /module\s+"environment"\s*\{/.exec(src);
  if (!m) throw new Error(`${env}: no module "environment" block`);
  return entries(balanced(src, m.index + m[0].length - 1));
}

/** `variable "X" { default = ... }` defaults in a file (undefined when there is none). */
export function variableDefaults(src: string): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  const re = /variable\s+"([\w-]+)"\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const body = stripComments(balanced(src, m.index + m[0].length - 1));
    const d = /(?:^|\n)\s*default\s*=\s*(.+)/.exec(body);
    out[m[1]] = d ? d[1].trim() : undefined;
  }
  return out;
}

/** `key = value` lines of a tfvars file. */
export function tfvars(env: Env): Record<string, string> {
  const p = `infra/terraform/envs/${env}/terraform.tfvars`;
  return fs.existsSync(p) ? entries(read(p)) : {};
}

export type Resolved = { kind: 'literal'; value: string } | { kind: 'computed' } | { kind: 'missing'; why: string };

/**
 * What an env value expression evaluates to for one environment: a literal
 * string, something Terraform computes (a resource attribute or a local
 * built from one: never blank), or missing (a variable nothing sets).
 */
export function resolve(expr: string, env: Env): Resolved {
  const e = expr.trim();
  const lit = /^"(.*)"$/.exec(e);
  if (lit) return { kind: 'literal', value: lit[1] };
  const wrapped = /^tostring\((.+)\)$/.exec(e);
  if (wrapped) return resolve(wrapped[1], env);
  const v = /^var\.([\w-]+)$/.exec(e);
  if (v) return resolveModuleVar(v[1], env);
  if (/^(local|google_[\w]+|random_[\w]+)\./.test(e)) return { kind: 'computed' };
  return { kind: 'missing', why: `unrecognised expression ${e}` };
}

function resolveModuleVar(name: string, env: Env): Resolved {
  const args = moduleArgs(env);
  if (name in args) {
    const a = args[name].trim();
    const rootVar = /^var\.([\w-]+)$/.exec(a);
    if (!rootVar) return resolve(a, env);
    // A root variable: its tfvars value, else its default, else it must be passed at plan time.
    const tv = tfvars(env)[rootVar[1]];
    if (tv !== undefined) return resolve(tv, env);
    const rootDefaults = variableDefaults(read(`infra/terraform/envs/${env}/main.tf`));
    const d = rootDefaults[rootVar[1]];
    if (d !== undefined) return resolve(d, env);
    return { kind: 'missing', why: `${env} root variable ${rootVar[1]} has no value and no default` };
  }
  const d = variableDefaults(read(`${MODULE}/variables.tf`))[name];
  if (d === undefined) return { kind: 'missing', why: `${env} doesn't pass ${name} and the module has no default` };
  return resolve(d, env);
}

/** The text of every .js/.cjs/.mjs source file under a directory. */
export function srcFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = `${d}/${e.name}`;
      if (e.isDirectory()) walk(p);
      else if (/\.(c|m)?js$/.test(e.name)) out.push(read(p));
    }
  };
  walk(dir);
  return out;
}

/** All of a directory's source as one string, for "does this code use X" checks. */
export const srcText = (dir: string) => srcFiles(dir).join('\n');

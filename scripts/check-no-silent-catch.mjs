#!/usr/bin/env node
/**
 * check-no-silent-catch.mjs: no error may be swallowed (CLAUDE.md §1). This is
 * a syntax-aware replacement for the old grep gate.
 *
 * The grep version only matched one-line idioms. It missed
 * `.catch(() => '')`, `catch { return ''; }`, and multi-line forms, and those
 * gaps hid real bugs: an STT decode failure that silently dropped transcript,
 * and malformed captions reported to users as "no captions". This one parses
 * every file with the TypeScript compiler and inspects every `catch` clause and
 * every `.catch(fn)` handler.
 *
 * A handler is OK if its body does at least one of these:
 *   1. throws;
 *   2. logs, i.e. calls any `.error/.warn/.info/.debug/.fatal(...)`, whatever the
 *      logger is called (log, reqLog, qlog, (opts.log ?? log), ...);
 *   3. uses the caught error: passes it on (reject(err), next(err)), keeps it
 *      (lastErr = err), or answers with it (res.status(400).json({ error: err.message }));
 *   4. carries an explicit marker saying why swallowing is correct, on the line
 *      before the catch or inside its body:
 *        // silent-catch-ok: <reason>
 * Anything else fails CI.
 *
 *   node scripts/check-no-silent-catch.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

// Server, shared and web code (CLAUDE.md §1). The web's unreadable-body reads go
// through apps/web/src/lib/http.ts, which logs them.
const ROOTS = ['packages', 'services', 'functions', 'scripts', 'apps/web/src'];
// Whole path segments only (so e.g. `builder.js` is not skipped), plus type declarations.
const SKIP_DIR = /(^|\/)(node_modules|dist|build|generated)(\/|$)/;
const skip = (p) => SKIP_DIR.test(p) || p.endsWith('.d.ts');
const LOG_METHODS = new Set(['error', 'warn', 'info', 'debug', 'fatal']);
const MARKER = /silent-catch-ok:[ \t]*[^\s*]/; // reason must be on the same line

function* sourceFiles(dir) {
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (skip(p)) continue;
    if (fs.statSync(p).isDirectory()) yield* sourceFiles(p);
    else if (/\.(c|m)?[jt]sx?$/.test(name)) yield p;
  }
}

/** Does `body` throw, log, or use the caught error `binding`? */
function handles(body, binding) {
  let ok = false;
  const visit = (n) => {
    if (ok) return;
    if (ts.isThrowStatement(n)) ok = true;
    else if (ts.isCallExpression(n)) {
      const callee = n.expression;
      if (ts.isPropertyAccessExpression(callee) && LOG_METHODS.has(callee.name.text)) ok = true;
    } else if (binding && ts.isIdentifier(n) && n.text === binding) ok = true;
    if (!ok) ts.forEachChild(n, visit);
  };
  visit(body);
  return ok;
}

function markerNear(sf, node) {
  const text = sf.getFullText();
  const start = node.getStart(sf);
  const lineStart = text.lastIndexOf('\n', text.lastIndexOf('\n', start - 1) - 1) + 1; // the line before
  return MARKER.test(text.slice(lineStart, node.getEnd()));
}

export function findSilentCatches(file, source) {
  const kind = /\.tsx?$/.test(file) ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
  const out = [];
  const report = (node, what) => {
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    out.push({ file, line: line + 1, what, snippet: node.getText(sf).replace(/\s+/g, ' ').slice(0, 100) });
  };
  const visit = (node) => {
    if (ts.isCatchClause(node)) {
      const binding = node.variableDeclaration && ts.isIdentifier(node.variableDeclaration.name)
        ? node.variableDeclaration.name.text : null;
      if (!handles(node.block, binding) && !markerNear(sf, node)) report(node, 'catch clause');
    } else if (
      ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === 'catch' && node.arguments.length > 0
    ) {
      const h = node.arguments[0];
      if (ts.isArrowFunction(h) || ts.isFunctionExpression(h)) {
        const p = h.parameters[0];
        const binding = p && ts.isIdentifier(p.name) ? p.name.text : null;
        if (!handles(h.body, binding) && !markerNear(sf, node)) report(node, '.catch() handler');
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const hits = [];
  let files = 0;
  for (const root of ROOTS) {
    for (const f of sourceFiles(root)) {
      files += 1;
      hits.push(...findSilentCatches(f, fs.readFileSync(f, 'utf8')));
    }
  }
  if (hits.length) {
    for (const h of hits) console.log(`${h.file}:${h.line}: silent ${h.what}: ${h.snippet}`);
    console.log(`\nERROR: ${hits.length} swallowed error(s). Throw, log it (any .error/.warn/...),`);
    console.log('use the caught error, or mark why swallowing is correct:  // silent-catch-ok: <reason>');
    process.exit(1);
  }
  console.log(`OK: no silent catch handlers (${files} files, syntax-aware).`);
}

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
 * A handler is OK if every path out of it (a return, a break or continue out of
 * the catch, or falling off its end) does at least one of these on the way:
 *   1. throws;
 *   2. logs, i.e. calls any `.error/.warn/.info/.debug/.fatal(...)`, whatever the
 *      logger is called (log, reqLog, qlog, req.log, (opts.log ?? log), ...);
 *   3. lets the caught error escape: passes it on (reject(err), next(err)), keeps it
 *      (lastErr = err), or returns or answers with it
 *      (res.status(400).json({ error: err.message })).
 * Reading the error only to decide (`if (err?.code !== X) throw err;`,
 * `err instanceof Y`, `isGone(err) ? ...`) handles nothing: the path that doesn't
 * throw still has to log or pass it on. The whole handler is also OK if it carries
 * an explicit marker saying why swallowing is correct, on the line before the
 * catch or inside its body:
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
const ROOTS = ['packages', 'services', 'functions', 'scripts', 'apps/web/src', 'apps/extension/src'];
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

const K = ts.SyntaxKind;
// Operators whose result can be the error itself (or a string built from it).
const VALUE_OPS = new Set([K.PlusToken, K.QuestionQuestionToken, K.BarBarToken, K.AmpersandAmpersandToken]);
const isAssignment = (n) => ts.isBinaryExpression(n)
  && n.operatorToken.kind >= K.FirstAssignment && n.operatorToken.kind <= K.LastAssignment;

/** Every name a binding (`err`, `{ code }`, `[a, b]`) declares. */
function namesOf(name) {
  if (!name) return [];
  if (ts.isIdentifier(name)) return [name.text];
  return name.elements.flatMap((e) => (ts.isOmittedExpression(e) ? [] : namesOf(e.name)));
}

/** Is this identifier a read of a variable (not a property or declaration name)? */
function isRead(id) {
  const p = id.parent;
  return !((ts.isPropertyAccessExpression(p) && p.name === id)
    || ((ts.isPropertyAssignment(p) || ts.isMethodDeclaration(p)) && p.name === id)
    || ((ts.isVariableDeclaration(p) || ts.isParameter(p) || ts.isBindingElement(p)) && p.name === id)
    || (ts.isBindingElement(p) && p.propertyName === id)
    || (isAssignment(p) && p.left === id));
}

function readsOf(root, names) {
  const out = [];
  const visit = (n) => {
    if (ts.isIdentifier(n) && names.has(n.text) && isRead(n)) out.push(n);
    ts.forEachChild(n, visit);
  };
  visit(root);
  return out;
}

function hasLog(root) {
  let found = false;
  const visit = (n) => {
    if (found) return;
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)
      && LOG_METHODS.has(n.expression.name.text)) found = true;
    else ts.forEachChild(n, visit);
  };
  visit(root);
  return found;
}

/**
 * `if (log) log.warn(...)`, `if (req.log && typeof req.log.warn === 'function')`: a
 * condition that only checks for the logger the branch then calls is part of
 * logging, not a path that skips it.
 */
function isLoggerGuard(cond, then) {
  const receivers = new Set();
  const visit = (n) => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)
      && LOG_METHODS.has(n.expression.name.text)) receivers.add(n.expression.expression.getText());
    ts.forEachChild(n, visit);
  };
  visit(then);
  const guard = (e) => {
    while (ts.isParenthesizedExpression(e)) e = e.expression;
    if (ts.isBinaryExpression(e) && e.operatorToken.kind === K.AmpersandAmpersandToken) return guard(e.left) && guard(e.right);
    if (ts.isBinaryExpression(e) && ts.isTypeOfExpression(e.left) && ts.isStringLiteral(e.right)
      && (e.operatorToken.kind === K.EqualsEqualsEqualsToken || e.operatorToken.kind === K.EqualsEqualsToken)) {
      return guard(e.left.expression);
    }
    if (!ts.isIdentifier(e) && !ts.isPropertyAccessExpression(e)) return false;
    return receivers.has(e.getText())
      || (ts.isPropertyAccessExpression(e) && LOG_METHODS.has(e.name.text) && receivers.has(e.expression.getText()));
  };
  return receivers.size > 0 && guard(cond);
}

/**
 * Where a read of the error goes on its way up to `root`: 'sink' if it escapes
 * (an assignment to something outside the catch, a nested function's return or
 * throw, or a call made for its effect: `reject(err);`, `reportCrash('x', err);`),
 * 'root' if it reaches `root` as (part of) its value, 'called' if it reaches it
 * through a call's result (`codeOf(err)`, `wrap(err)`), null if it is only
 * inspected (compared, instanceof, typeof, !, a condition). A call whose result
 * only feeds a decision (`if (isGone(err))`) handles nothing.
 */
function flow(id, root, locals) {
  let n = id;
  let called = false;
  while (n !== root) {
    const p = n.parent;
    if ((ts.isCallExpression(p) || ts.isNewExpression(p)) && p.arguments?.includes(n)) {
      called = true;
      n = p;
      continue;
    }
    if (isAssignment(p)) {
      return p.right === n && !(ts.isIdentifier(p.left) && locals.has(p.left.text)) ? 'sink' : null;
    }
    if (ts.isReturnStatement(p) || ts.isThrowStatement(p) || ts.isYieldExpression(p)
      || (ts.isArrowFunction(p) && p.body === n)) return 'sink';
    if (ts.isExpressionStatement(p) || ts.isVoidExpression(p)) return called ? 'sink' : null;
    const passes = ts.isParenthesizedExpression(p) || ts.isAsExpression(p) || ts.isNonNullExpression(p)
      || ts.isTypeAssertionExpression(p) || ts.isSatisfiesExpression(p) || ts.isAwaitExpression(p)
      || ts.isSpreadElement(p) || ts.isSpreadAssignment(p) || ts.isShorthandPropertyAssignment(p)
      || ts.isArrayLiteralExpression(p) || ts.isObjectLiteralExpression(p)
      || (ts.isPropertyAssignment(p) && p.initializer === n)
      || ts.isTemplateSpan(p) || ts.isTemplateExpression(p)
      || ((ts.isPropertyAccessExpression(p) || ts.isElementAccessExpression(p) || ts.isCallExpression(p))
        && p.expression === n) // err.message, err.message.slice(0, 200)
      || (ts.isConditionalExpression(p) && p.condition !== n)
      || (ts.isBinaryExpression(p) && VALUE_OPS.has(p.operatorToken.kind));
    if (!passes) return null;
    n = p;
  }
  return called ? 'called' : 'root';
}

/**
 * The error's names inside `body`: the parameter plus every local that takes a
 * value derived from it (`const msg = err.message`), so a guard can't launder the
 * error through a local and a local that is returned still counts.
 */
function errorNames(body, params) {
  const locals = new Set(params);
  const defs = []; // [names, value]
  const visit = (n) => {
    if (ts.isVariableDeclaration(n)) {
      const names = namesOf(n.name);
      for (const x of names) locals.add(x);
      if (n.initializer) defs.push([names, n.initializer]);
    }
    ts.forEachChild(n, visit);
  };
  visit(body);
  const assigns = (n) => {
    if (isAssignment(n) && ts.isIdentifier(n.left) && locals.has(n.left.text)) defs.push([[n.left.text], n.right]);
    ts.forEachChild(n, assigns);
  };
  assigns(body);
  const names = new Set(params);
  for (let grew = true; grew;) {
    grew = false;
    for (const [targets, value] of defs) {
      if (targets.every((x) => names.has(x))) continue;
      if (readsOf(value, names).some((id) => flow(id, value, locals))) {
        for (const x of targets) names.add(x);
        grew = true;
      }
    }
  }
  return { names, locals };
}

/**
 * Does every path out of a catch body throw, log, or let the error escape first?
 * `body` is the catch block, or a `.catch` handler's function body or expression.
 * Walks the handler's own control flow (nested functions are just values). The
 * state `h` is true once every path reaching that point has handled the error,
 * null where the code can't be reached.
 */
function handles(body, params) {
  const { names, locals } = errorNames(body, params);
  let ok = true;
  const exit = (h) => { if (!h) ok = false; };
  const merge = (...hs) => {
    const live = hs.filter((h) => h !== null);
    return live.length ? live.every(Boolean) : null;
  };
  const frames = []; // loops and switches inside the handler: where a break lands
  // Does `e` log, or let the error escape? `as` is what happens to e's own value:
  // 'returned', 'discarded' (a statement: a call there is made for its effect),
  // or 'kept' (a local's initializer: the local carries the error on).
  const uses = (e, as) => hasLog(e) || readsOf(e, names).some((id) => {
    const f = flow(id, e, locals);
    return f === 'sink' || (as === 'returned' && f !== null) || (as === 'discarded' && f === 'called');
  });
  const ret = (e, h) => {
    while (e && ts.isParenthesizedExpression(e)) e = e.expression;
    if (e && ts.isConditionalExpression(e)) {
      const hc = h || hasLog(e.condition);
      ret(e.whenTrue, hc);
      ret(e.whenFalse, hc);
    } else exit(h || (!!e && uses(e, 'returned')));
  };
  const block = (list, h) => {
    for (const s of list) if ((h = stmt(s, h)) === null) break;
    return h;
  };
  const stmt = (s, h) => {
    if (h === null) return null;
    if (ts.isBlock(s)) return block(s.statements, h);
    if (ts.isExpressionStatement(s)) return h || uses(s.expression, 'discarded');
    if (ts.isVariableStatement(s)) {
      return h || s.declarationList.declarations.some((d) => d.initializer && uses(d.initializer, 'kept'));
    }
    if (ts.isThrowStatement(s)) return null;
    if (ts.isReturnStatement(s)) { ret(s.expression, h); return null; }
    if (ts.isIfStatement(s)) {
      const hc = h || hasLog(s.expression);
      // With no logger there is nowhere to log: that path counts with the logging one.
      const skipped = isLoggerGuard(s.expression, s.thenStatement) ? null : hc;
      return merge(stmt(s.thenStatement, hc), s.elseStatement ? stmt(s.elseStatement, hc) : skipped);
    }
    if (ts.isIterationStatement(s, false)) {
      const head = ts.isForStatement(s) ? [s.initializer, s.condition, s.incrementor] : [s.expression];
      const hc = h || head.some((e) => e && hasLog(e));
      const frame = { loop: true, breaks: [] };
      frames.push(frame);
      stmt(s.statement, hc);
      frames.pop();
      const forever = ts.isForStatement(s) ? !s.condition
        : (ts.isWhileStatement(s) || ts.isDoStatement(s)) && s.expression.kind === K.TrueKeyword;
      return merge(forever ? null : hc, ...frame.breaks); // the body may run zero times
    }
    if (ts.isSwitchStatement(s)) {
      const hd = h || hasLog(s.expression);
      const frame = { loop: false, breaks: [] };
      frames.push(frame);
      let prev = null;
      for (const c of s.caseBlock.clauses) prev = block(c.statements, merge(hd, prev));
      frames.pop();
      const hasDefault = s.caseBlock.clauses.some(ts.isDefaultClause);
      return merge(prev, ...frame.breaks, hasDefault ? null : hd);
    }
    if (ts.isBreakStatement(s) || ts.isContinueStatement(s)) {
      // A labelled jump, or one with no loop/switch inside the handler, leaves it.
      const target = s.label ? undefined
        : frames.findLast((f) => f.loop || ts.isBreakStatement(s));
      if (!target) exit(h);
      else if (ts.isBreakStatement(s)) target.breaks.push(h);
      return null; // a continue lands back on its loop, whose exit is already counted
    }
    if (ts.isTryStatement(s)) {
      const out = merge(stmt(s.tryBlock, h), s.catchClause ? stmt(s.catchClause.block, h) : null);
      return s.finallyBlock ? stmt(s.finallyBlock, out) : out;
    }
    if (ts.isLabeledStatement(s)) return stmt(s.statement, h);
    return h; // declarations, empty statements, ...
  };
  if (ts.isBlock(body)) exit(stmt(body, false) ?? true);
  else ret(body, false);
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
      const params = namesOf(node.variableDeclaration?.name);
      if (!handles(node.block, params) && !markerNear(sf, node)) report(node, 'catch clause');
    } else if (
      ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === 'catch' && node.arguments.length > 0
    ) {
      const h = node.arguments[0];
      if (ts.isArrowFunction(h) || ts.isFunctionExpression(h)) {
        if (!handles(h.body, namesOf(h.parameters[0]?.name)) && !markerNear(sf, node)) report(node, '.catch() handler');
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
    console.log(`\nERROR: ${hits.length} swallowed error(s). Every path out of a catch must throw, log (any`);
    console.log('.error/.warn/...), or pass on or return the caught error; checking it in a condition is not');
    console.log('enough. Or mark why swallowing is correct:  // silent-catch-ok: <reason>');
    process.exit(1);
  }
  console.log(`OK: no silent catch handlers (${files} files, syntax-aware).`);
}

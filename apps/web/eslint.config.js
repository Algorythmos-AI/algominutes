// apps/web lint (flat config). The new app (src/app, src/routes, src/main) is
// held to every rule as an error. The legacy code still waiting to be ported
// (plan W2–W11) gets the same rules as warnings, so porting a file means fixing it.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

const LEGACY = ['src/components/**', 'src/lib/**', 'src/plugins/**', 'src/firebase.ts', 'src/types.ts'];

const rules = {
  ...js.configs.recommended.rules,
  ...Object.assign({}, ...tseslint.configs.recommended.map((c) => c.rules ?? {})),
  ...reactHooks.configs.recommended.rules,
  // TypeScript checks names itself (typescript-eslint's advice for TS files).
  'no-undef': 'off',
  // Failures go through reportCrash or the structured client logger, never the console.
  'no-console': 'error',
};
const isOff = (v) => v === 'off' || v === 0 || (Array.isArray(v) && (v[0] === 'off' || v[0] === 0));
const asWarnings = Object.fromEntries(
  Object.entries(rules).map(([k, v]) => [k, isOff(v) ? v : Array.isArray(v) ? ['warn', ...v.slice(1)] : 'warn']),
);

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { files: ['**/*.{ts,tsx}'], plugins: { 'react-hooks': reactHooks }, rules },
  { files: LEGACY, rules: asWarnings },
);

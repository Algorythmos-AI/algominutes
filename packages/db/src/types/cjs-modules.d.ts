// Ambient declarations for the CommonJS helpers that live in @algominutes/ai and
// are imported (as default) by the repo layer. The .cjs files have no types of
// their own; call sites cast the default export to the precise shape they need
// (see notes-repo.ts). This keeps db typecheckable without emitting types for
// the shared CJS package.
declare module '@algominutes/ai/note-edit.cjs' {
  const mod: unknown;
  export default mod;
}
declare module '@algominutes/ai/logger.cjs' {
  const mod: unknown;
  export default mod;
}

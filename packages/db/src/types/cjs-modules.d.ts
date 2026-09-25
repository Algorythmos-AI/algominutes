// Ambient declarations for the repo layer's CommonJS modules, imported (as
// default) by its TypeScript. The .cjs files have no types of their own; call
// sites cast the default export to the precise shape they need (see
// notes-repo.ts). This keeps db typecheckable without emitting types for them.
declare module '@algominutes/db/note-edit.cjs' {
  const mod: unknown;
  export default mod;
}
declare module '@algominutes/ai/pg-config.cjs' {
  const mod: unknown;
  export default mod;
}
declare module '@algominutes/ai/logger.cjs' {
  const mod: unknown;
  export default mod;
}
declare module '@algominutes/ai/note-storage.cjs' {
  const mod: unknown;
  export default mod;
}

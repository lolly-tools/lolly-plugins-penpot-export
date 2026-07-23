// Untyped libs reached only through type-level imports into the lolly web
// shell's export.ts (never bundled here — export-image-meta.ts type-imports
// ExportOpts from it, which drags the whole module graph into the typecheck).
declare module 'dom-to-image-more';
declare module 'gifenc';

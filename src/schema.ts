//  — barrel re-export. The schemas previously inlined here are
// now split into per-domain files under `src/schema/*.ts`. All public
// names remain stable; consumers continue to `import { Foo } from "./schema"`.
// See `docs/architecture/agent-readable-code-map.md` for the domain map.
export * from "./schema/agent";
export * from "./schema/workspace";
export * from "./schema/contentHub";
export * from "./schema/degradation";
export * from "./schema/context";
export * from "./schema/archive";
export * from "./schema/channel";

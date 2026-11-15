// Ambient declarations for the browser half (src/client/index.js).
//
// scripts/build-client.mjs wraps the client source in
// `window.__ModuleLoader__.load({ id, factory: (require) => { var module = ...; ... } })`,
// so `require`, `module` and `exports` are injected by the wrapper rather than
// by Node (TypeScript already understands `module.exports` / `require()` in a
// CommonJS .js file, so no extra declarations are needed for them).
//
// @types/react is intentionally not a dependency: React is acquired through
// the DSH ModuleLoader. This is a minimal, loosely typed stand-in that covers
// only the hooks and `createElement` the client actually uses.

declare module 'react' {
  type SetState<S> = (value: S | ((previous: S) => S)) => void;
  export function useState<S>(initial: S | (() => S)): [S, SetState<S>];
  export function useRef<T>(initial: T): { current: T };
  export function useCallback<F extends (...args: never[]) => unknown>(callback: F, deps: readonly unknown[]): F;
  export function useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void;
  export function createElement(type: unknown, props?: Record<string, unknown> | null, ...children: unknown[]): unknown;
}

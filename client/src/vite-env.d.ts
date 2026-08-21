/// <reference types="vite/client" />

/**
 * Vite's own `ImportMetaEnv` types every unknown key as `any` through an index signature,
 * which is what `services/api.ts` would otherwise be reading — and `any ?? "/api"` is
 * `any`, so the base URL would flow into `fetch` unchecked. Interface merging narrows the
 * one variable this client actually defines to `string | undefined` and documents it in a
 * place a reader looks for it. The index signature stays, so a *misspelled* key is still
 * `any`; only the declared one is typed.
 */
interface ImportMetaEnv {
  /**
   * Absolute origin of the search API, e.g. `https://search-api.example.com/api`.
   *
   * Unset in development and in a same-origin deployment, where `/api` is correct and the
   * Vite proxy or the serving Node instance handles it. Inlined at build time, so it is a
   * build input and not a runtime setting.
   */
  readonly VITE_API_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

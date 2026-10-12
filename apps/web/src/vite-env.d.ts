declare module 'virtual:ogc-tokens.css';

interface ImportMetaEnv {
  /** Base URL of the OGC API. Defaults to the same-origin `/api` path. */
  readonly VITE_API_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

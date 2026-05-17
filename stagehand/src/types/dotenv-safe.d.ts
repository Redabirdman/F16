// Minimal ambient declaration for dotenv-safe (no upstream types as of 9.1.0).
// Drop this file once @types/dotenv-safe is added or the package ships its own.
declare module 'dotenv-safe' {
  interface DotenvSafeOptions {
    path?: string;
    example?: string;
    allowEmptyValues?: boolean;
    encoding?: string;
    debug?: boolean;
    sample?: string;
  }
  interface DotenvSafeOutput {
    parsed?: Record<string, string>;
    required?: Record<string, string>;
    error?: Error;
  }
  function config(options?: DotenvSafeOptions): DotenvSafeOutput;
  const _default: { config: typeof config };
  export default _default;
  export { config };
}

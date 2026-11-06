export interface Check { readonly name: string }

export interface Finding { source: string; message: string }

/** A lazy check: describes what to verify, runs only when `verify` asks for it. */
export function check(name: string, run: () => Promise<readonly Finding[]>): Check;

// The release build sets this constant when Bun embeds the CLI and its dependencies.
declare const EIN_STANDALONE: boolean;
export const standalone = typeof EIN_STANDALONE !== "undefined" && EIN_STANDALONE;
export const einCommand = standalone ? "ein" : "bun run ein";

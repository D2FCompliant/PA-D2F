declare module "*.xsd" {
  const content: string;
  export default content;
}

declare module "*.json" {
  const content: unknown;
  export default content;
}

declare module "saxon-js" {
  const SaxonJS: { transform(options: Record<string, unknown>, mode?: "sync" | "async"): { principalResult?: unknown } };
  export default SaxonJS;
}

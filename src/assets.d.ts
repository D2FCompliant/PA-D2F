declare module "*.xsd" {
  const content: string;
  export default content;
}

declare module "*.json" {
  const content: unknown;
  export default content;
}

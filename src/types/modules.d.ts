// Untyped JS modules we load; app.ts narrows them to the few members it uses.
declare module '@parse/s3-files-adapter' {
  const S3Adapter: unknown;
  export default S3Adapter;
}

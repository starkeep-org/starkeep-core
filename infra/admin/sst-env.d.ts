export {};

declare global {
  const $app: { stage: string };
  const $config: <T>(config: T) => T;
  const sst: {
    aws: {
      Vpc: new (name: string, args: Record<string, unknown>) => unknown;
      Postgres: new (name: string, args: Record<string, unknown>) => { url: string };
      Bucket: new (name: string, args: Record<string, unknown>) => { name: string };
      Function: new (name: string, args: Record<string, unknown>) => { name: string };
      Remix: new (name: string, args: Record<string, unknown>) => { url: string };
      dns: (args: Record<string, unknown>) => unknown;
    };
  };
  const aws: {
    getCallerIdentity: (args: Record<string, unknown>) => Promise<{ accountId: string }>;
  };
}

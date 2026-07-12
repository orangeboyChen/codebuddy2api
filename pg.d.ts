declare module 'pg' {
  export class Pool {
    public constructor(options?: { connectionString?: string });
  }
}

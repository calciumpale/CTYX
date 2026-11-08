import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {createDigitalHumanStore} from '../app/lib/digital-human-store.ts';

export function digitalHumanFixture() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../drizzle/0024_yellow_wasp.sql', import.meta.url), 'utf8'));
  sqlite.exec(`CREATE TABLE workbench_api_connections(user_id TEXT,kind TEXT,enabled INTEGER,base_url TEXT,model_name TEXT,secret_ciphertext TEXT,version INTEGER,updated_at TEXT,PRIMARY KEY(user_id,kind));
    CREATE TABLE workbench_member_accounts(account_id TEXT,owner_id TEXT,enabled INTEGER,role TEXT);
    INSERT INTO workbench_member_accounts VALUES('alice','owner',1,'sales'),('bob','owner',1,'sales'),('manager','owner',1,'manager');`);
  type Statement = {bind(...values: unknown[]): Statement; first(): Promise<unknown>; all(): Promise<unknown>; run(): Promise<unknown>; execute(): {meta: {changes: number}}};
  const db = {
    prepare(sql: string): Statement {
      let values: unknown[] = [];
      return {
        bind(...next) { values = next; return this; },
        async first() { return sqlite.prepare(sql).get(...values as never[]) ?? null; },
        async all() { return {results: sqlite.prepare(sql).all(...values as never[])}; },
        async run() { return this.execute(); },
        execute() { return {meta: {changes: Number(sqlite.prepare(sql).run(...values as never[]).changes)}}; },
      };
    },
    async batch(statements: Statement[]) {
      sqlite.exec('BEGIN');
      try { const results = statements.map(statement => statement.execute()); sqlite.exec('COMMIT'); return results; }
      catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
  } as unknown as D1Database;
  const objects = new Map<string, Uint8Array>();
  const bucket = {
    async put(key: string, value: ReadableStream<Uint8Array> | Uint8Array) {
      if (value instanceof Uint8Array) objects.set(key, value);
      else {
        const reader = value.getReader(), parts: Uint8Array[] = []; let size = 0;
        while (true) { const {done, value} = await reader.read(); if (done) break; parts.push(value); size += value.length; }
        const bytes = new Uint8Array(size); let offset = 0; for (const part of parts) { bytes.set(part, offset); offset += part.length; } objects.set(key, bytes);
      }
      return {key};
    },
    async delete(key: string) { objects.delete(key); },
    async get(key: string, options?: {range?: {offset: number; length: number}}) {
      const bytes = objects.get(key); if (!bytes) return null;
      const range = options?.range, output = range ? bytes.subarray(range.offset, range.offset + range.length) : bytes;
      return {size: bytes.length, body: new Response(new Uint8Array(output).buffer).body};
    },
    async head(key: string) { const value = objects.get(key); return value ? {size: value.length} : null; },
  } as unknown as R2Bucket;
  const environment = {DB: db, BUCKET: bucket, CONFIG_ENCRYPTION_KEY: 'ab'.repeat(32)};
  const store = createDigitalHumanStore(environment);
  return {sqlite, environment, store, bucket, objects};
}
export const savedZego = {action: 'save', version: 0, appId: '123456', agentId: 'registered-agent', secret: 'private-server-secret', enabled: true, avatarGrants: [{digitalHumanId: 'private-avatar', memberId: 'alice'}]};
export const pngBytes = new Uint8Array([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82]);
export const uploadInput = {action: 'createAsset', requestId: 'upload-request-123', name: '照片形象', sourceKind: 'photo', fileName: '形象.png', mime: 'image/png', size: pngBytes.length};
export function zegoResponse(input: RequestInfo | URL) {
  const action = new URL(String(input)).searchParams.get('Action');
  return Response.json({Code: 0, RequestId: 'request-safe', Message: 'success', ...(action === 'DeleteAgentInstance' ? {} : {Data: action === 'GetDigitalHumanInfo' ? {DigitalHumanId: 'private-avatar', Name: '形象', IsPublic: false} : action === 'CreateLiveDigitalHumanAgentInstance' ? {AgentInstanceId: 'instance-original', DigitalHumanConfig: '{}'} : action === 'QueryAgentInstanceStatus' ? {Status: 'IDLE'} : action === 'SendAgentInstanceTTS' ? {Round: 1} : {Total: 0, DigitalHumans: []}})});
}

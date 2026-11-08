import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { createWebProspectStore } from '../app/lib/web-prospect-store.ts';
export function fixture() { const sqlite = new DatabaseSync(':memory:'); for (const f of readdirSync(new URL('../drizzle/', import.meta.url)).filter(f => f.endsWith('.sql')).sort())
    sqlite.exec(readFileSync(new URL('../drizzle/' + f, import.meta.url), 'utf8')); const db = { prepare(sql: string) { let values: unknown[] = []; return { bind(...v: unknown[]) { values = v; return this; }, async first() { return sqlite.prepare(sql).get(...values as never[]) ?? null; }, async all() { return { results: sqlite.prepare(sql).all(...values as never[]) }; }, async run() { return { meta: { changes: Number(sqlite.prepare(sql).run(...values as never[]).changes) } }; } }; }, async batch(statements: {
        run: () => Promise<unknown>;
    }[]) { sqlite.exec('BEGIN'); try {
        const out = [];
        for (const s of statements)
            out.push(await s.run());
        sqlite.exec('COMMIT');
        return out;
    }
    catch (e) {
        sqlite.exec('ROLLBACK');
        throw e;
    } } }; return { sqlite, db: db as unknown as D1Database, store: createWebProspectStore(db as unknown as D1Database) }; }

import type { DataEngine, ImportOptions, ImportResult } from '../engine/engine';
import { tableNameFor } from '../engine/engine';
import { oracleProvider } from './oracle';
import { postgresProvider } from './postgres';
import { cleanSql, type ConnectionProfile, type ConnectionStore, type DbKind, type DbObject, type DbProvider, type DbSession } from './types';

export const PROVIDERS: Record<DbKind, DbProvider> = {
  oracle: oracleProvider,
  postgres: postgresProvider,
};

/** Rows fetched per round trip. Large batches matter most on high-latency links. */
export const BATCH_SIZE = 25_000;

/**
 * Keeps one open session per saved connection and imports query results into
 * the DuckDB engine. Sessions are opened lazily and reopened after a failure.
 */
export class DatabaseService {
  private readonly sessions = new Map<string, Promise<DbSession>>();

  constructor(
    readonly store: ConnectionStore,
    private readonly providers: Record<string, DbProvider> = PROVIDERS,
  ) {}

  provider(kind: string): DbProvider {
    const p = this.providers[kind];
    if (!p) {
      throw new Error(`Unsupported database type: ${kind}`);
    }
    return p;
  }

  /** Opens a throwaway session to check a profile before it is saved. */
  async test(profile: ConnectionProfile, password: string | undefined): Promise<string> {
    const session = await this.provider(profile.kind).connect(profile, password);
    try {
      return session.serverVersion;
    } finally {
      await session.close();
    }
  }

  isConnected(id: string): boolean {
    return this.sessions.has(id);
  }

  async session(profile: ConnectionProfile): Promise<DbSession> {
    let s = this.sessions.get(profile.id);
    if (s) {
      const live = await s.then(
        (session) => session.ping().then(() => true, () => false),
        () => false,
      );
      if (live) {
        return s;
      }
      await this.disconnect(profile.id);
    }
    s = this.store.getPassword(profile.id).then((pw) => this.provider(profile.kind).connect(profile, pw));
    this.sessions.set(profile.id, s);
    s.catch(() => this.sessions.delete(profile.id));
    return s;
  }

  async disconnect(id: string): Promise<void> {
    const s = this.sessions.get(id);
    this.sessions.delete(id);
    await s?.then((session) => session.close()).catch(() => undefined);
  }

  async disconnectAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.disconnect(id)));
  }

  async importTable(profile: ConnectionProfile, obj: DbObject, engine: DataEngine, opts: ImportOptions = {}): Promise<ImportResult> {
    const session = await this.session(profile);
    return this.run(session, session.selectAll(obj), tableNameFor(obj.name), `${profile.name}: ${obj.schema}.${obj.name}`, engine, opts);
  }

  async importQuery(profile: ConnectionProfile, sql: string, engine: DataEngine, opts: ImportOptions = {}, tableName = 'query'): Promise<ImportResult> {
    const session = await this.session(profile);
    return this.run(session, cleanSql(sql), tableName, `${profile.name}: SQL query`, engine, opts);
  }

  private async run(session: DbSession, sql: string, name: string, source: string, engine: DataEngine, opts: ImportOptions): Promise<ImportResult> {
    const cursor = await session.query(sql, BATCH_SIZE);
    try {
      return await engine.importRows(name, source, cursor.columns, () => cursor.next(), opts);
    } finally {
      await cursor.close().catch(() => undefined);
    }
  }
}

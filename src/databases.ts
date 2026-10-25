import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import { DatabaseService, PROVIDERS } from './db/service';
import type { ConnectionProfile, ConnectionStore, DbObject } from './db/types';
import type { DataEngine, ImportOptions, ImportResult } from './engine/engine';

const PROFILES_KEY = 'vibe.connections';

/** Profiles live in global state; passwords only in VS Code's secret storage. */
class VscodeConnectionStore implements ConnectionStore {
  constructor(private readonly context: vscode.ExtensionContext) {}

  list(): ConnectionProfile[] {
    return this.context.globalState.get<ConnectionProfile[]>(PROFILES_KEY, []);
  }

  async save(profile: ConnectionProfile): Promise<void> {
    const rest = this.list().filter((p) => p.id !== profile.id);
    await this.context.globalState.update(PROFILES_KEY, [...rest, profile].sort((a, b) => a.name.localeCompare(b.name)));
  }

  async remove(id: string): Promise<void> {
    await this.context.globalState.update(PROFILES_KEY, this.list().filter((p) => p.id !== id));
    await this.setPassword(id, undefined);
  }

  getPassword(id: string): Promise<string | undefined> {
    return Promise.resolve(this.context.secrets.get(`vibe.password.${id}`));
  }

  async setPassword(id: string, password: string | undefined): Promise<void> {
    if (password === undefined) {
      await this.context.secrets.delete(`vibe.password.${id}`);
    } else {
      await this.context.secrets.store(`vibe.password.${id}`, password);
    }
  }
}

type Node =
  | { type: 'connection'; profile: ConnectionProfile }
  | { type: 'schema'; profile: ConnectionProfile; schema: string; isDefault: boolean }
  | { type: 'object'; profile: ConnectionProfile; obj: DbObject }
  | { type: 'message'; text: string; error?: boolean };

function describe(p: ConnectionProfile): string {
  const label = PROVIDERS[p.kind]?.label ?? p.kind;
  const where = p.connectString || `${p.host ?? 'localhost'}:${p.port ?? PROVIDERS[p.kind]?.defaultPort}/${p.database ?? ''}`;
  return `${label} · ${p.user}@${where}`;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

class DatabaseTree implements vscode.TreeDataProvider<Node> {
  private readonly changed = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(private readonly service: DatabaseService) {}

  refresh(node?: Node): void {
    this.changed.fire(node);
  }

  getTreeItem(node: Node): vscode.TreeItem {
    switch (node.type) {
      case 'connection': {
        const item = new vscode.TreeItem(node.profile.name, vscode.TreeItemCollapsibleState.Collapsed);
        item.id = node.profile.id;
        item.description = describe(node.profile);
        item.tooltip = describe(node.profile);
        item.iconPath = new vscode.ThemeIcon(this.service.isConnected(node.profile.id) ? 'database' : 'plug');
        item.contextValue = 'connection';
        return item;
      }
      case 'schema': {
        const item = new vscode.TreeItem(
          node.schema,
          node.isDefault ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed,
        );
        item.id = `${node.profile.id}/${node.schema}`;
        item.iconPath = new vscode.ThemeIcon('symbol-namespace');
        item.contextValue = 'schema';
        return item;
      }
      case 'object': {
        const item = new vscode.TreeItem(node.obj.name, vscode.TreeItemCollapsibleState.None);
        item.id = `${node.profile.id}/${node.obj.schema}/${node.obj.name}`;
        item.description = node.obj.kind === 'view' ? 'view' : undefined;
        item.iconPath = new vscode.ThemeIcon(node.obj.kind === 'view' ? 'eye' : 'table');
        item.contextValue = 'dbObject';
        item.tooltip = `${node.obj.schema}.${node.obj.name}`;
        return item;
      }
      case 'message': {
        const item = new vscode.TreeItem(node.text, vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon(node.error ? 'error' : 'info');
        item.tooltip = node.text;
        return item;
      }
    }
  }

  async getChildren(node?: Node): Promise<Node[]> {
    if (!node) {
      return this.service.store.list().map((profile) => ({ type: 'connection', profile }));
    }
    try {
      if (node.type === 'connection') {
        const session = await this.service.session(node.profile);
        this.refreshIconSoon(node);
        const schemas = await session.listSchemas();
        const own = await session.defaultSchema();
        return schemas.map((schema) => ({ type: 'schema', profile: node.profile, schema, isDefault: schema === own }));
      }
      if (node.type === 'schema') {
        const session = await this.service.session(node.profile);
        const objects = await session.listObjects(node.schema);
        if (objects.length === 0) {
          return [{ type: 'message', text: 'No tables or views' }];
        }
        return objects.map((obj) => ({ type: 'object', profile: node.profile, obj }));
      }
    } catch (err) {
      return [{ type: 'message', text: `Could not connect: ${errorText(err)}`, error: true }];
    }
    return [];
  }

  private refreshIconSoon(node: Node): void {
    // The connection icon switches to "connected" once the first listing succeeds.
    setTimeout(() => this.changed.fire(node), 0);
  }
}

async function ask(prompt: string, value = '', opts: Partial<vscode.InputBoxOptions> = {}): Promise<string | undefined> {
  return vscode.window.showInputBox({ prompt, value, ignoreFocusOut: true, ...opts });
}

/** Walks through the connection fields. Returns undefined when the user backs out. */
async function editProfile(
  existing: ConnectionProfile | undefined,
): Promise<{ profile: ConnectionProfile; password: string | undefined; keepPassword: boolean } | undefined> {
  let kind = existing?.kind;
  if (!kind) {
    const pick = await vscode.window.showQuickPick(
      Object.values(PROVIDERS).map((p) => ({ label: p.label, dbKind: p.kind, description: p.kind === 'oracle' ? 'No Oracle client install needed' : undefined })),
      { title: 'New database connection', placeHolder: 'Database type', ignoreFocusOut: true },
    );
    if (!pick) {
      return undefined;
    }
    kind = pick.dbKind;
  }
  const provider = PROVIDERS[kind];
  const p: ConnectionProfile = existing ? { ...existing } : { id: randomUUID(), name: '', kind, user: '' };

  if (kind === 'oracle') {
    const mode = await vscode.window.showQuickPick(
      [
        { label: 'Host, port and service name', id: 'basic' },
        { label: 'Connect string', id: 'string', description: 'Easy Connect, TNS alias or full descriptor' },
      ],
      { title: 'How do you reach the database?', ignoreFocusOut: true },
    );
    if (!mode) {
      return undefined;
    }
    if (mode.id === 'string') {
      const cs = await ask('Connect string, for example dbhost:1521/ORCLPDB1, a tnsnames.ora alias, or (DESCRIPTION=...)', p.connectString);
      if (!cs) {
        return undefined;
      }
      p.connectString = cs.trim();
      const dir = await ask('Folder with tnsnames.ora or a wallet (optional, leave empty if not needed)', p.configDir ?? '');
      if (dir === undefined) {
        return undefined;
      }
      p.configDir = dir.trim() || undefined;
      p.host = p.port = p.database = undefined;
    } else {
      p.connectString = p.configDir = undefined;
    }
  }

  if (!p.connectString) {
    const host = await ask('Host', p.host ?? 'localhost');
    if (!host) {
      return undefined;
    }
    const port = await ask('Port', String(p.port ?? provider.defaultPort), {
      validateInput: (v) => (/^\d+$/.test(v.trim()) ? undefined : 'Enter a port number'),
    });
    if (!port) {
      return undefined;
    }
    const db = await ask(kind === 'oracle' ? 'Service name, for example ORCLPDB1 or FREEPDB1' : 'Database name', p.database ?? (kind === 'postgres' ? 'postgres' : ''));
    if (db === undefined) {
      return undefined;
    }
    p.host = host.trim();
    p.port = Number(port.trim());
    p.database = db.trim();
  }

  if (kind === 'postgres') {
    const ssl = await vscode.window.showQuickPick(
      [
        { label: 'No SSL', id: 'disable' as const },
        { label: 'SSL, verify the server certificate', id: 'verify-full' as const },
        { label: 'SSL, do not verify the certificate', id: 'require' as const },
      ],
      { title: 'Encryption', ignoreFocusOut: true },
    );
    if (!ssl) {
      return undefined;
    }
    p.ssl = ssl.id;
  }

  const user = await ask('User name', p.user);
  if (!user) {
    return undefined;
  }
  p.user = user.trim();
  const password = await ask(existing ? 'Password (leave empty to keep the saved one)' : 'Password', '', { password: true });
  if (password === undefined) {
    return undefined;
  }
  const defaultName = p.name || `${p.user}@${p.connectString ?? `${p.host}/${p.database}`}`;
  const name = await ask('Connection name', defaultName);
  if (!name) {
    return undefined;
  }
  p.name = name.trim();
  return { profile: p, password: password || undefined, keepPassword: !!existing && password === '' };
}

export interface DataImporter {
  importData(label: string, task: (engine: DataEngine, progress: (rows: number) => void) => Promise<ImportResult>): Promise<ImportResult | undefined>;
}

/**
 * Registers the Databases view and its commands. `importer` shows the data
 * panel and runs an import into its engine.
 */
export function registerDatabases(context: vscode.ExtensionContext, importer: () => Promise<DataImporter>): DatabaseService {
  const store = new VscodeConnectionStore(context);
  const service = new DatabaseService(store);
  const tree = new DatabaseTree(service);
  // Which connection each SQL editor runs against.
  const queryTargets = new Map<string, string>();
  let queryCount = 0;

  const pickConnection = async (title: string): Promise<ConnectionProfile | undefined> => {
    const profiles = store.list();
    if (profiles.length === 0) {
      const add = await vscode.window.showInformationMessage('No database connections yet.', 'Add Connection');
      if (add) {
        await vscode.commands.executeCommand('vibe.db.addConnection');
      }
      return undefined;
    }
    if (profiles.length === 1) {
      return profiles[0];
    }
    const pick = await vscode.window.showQuickPick(
      profiles.map((profile) => ({ label: profile.name, description: describe(profile), profile })),
      { title },
    );
    return pick?.profile;
  };

  const runImport = async (label: string, run: (engine: DataEngine, opts: ImportOptions) => Promise<ImportResult>) => {
    const target = await importer();
    const maxRows = vscode.workspace.getConfiguration('vibe').get<number>('database.maxRows', 5_000_000);
    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `VIBE: loading ${label}`, cancellable: true },
      (progress, token) =>
        target.importData(label, (engine, panelProgress) =>
          run(engine, {
            maxRows,
            isCancelled: () => token.isCancellationRequested,
            onProgress: (rows) => {
              panelProgress(rows);
              progress.report({ message: `${rows.toLocaleString()} rows` });
            },
          }),
        ),
    );
    tree.refresh();
    if (result?.truncated) {
      void vscode.window
        .showWarningMessage(
          `VIBE loaded the first ${result.table.rowCount.toLocaleString()} rows of ${label}. Raise "vibe.database.maxRows" to load more.`,
          'Open Setting',
        )
        .then((choice) => choice && vscode.commands.executeCommand('workbench.action.openSettings', 'vibe.database.maxRows'));
    }
  };

  const saveProfile = async (existing?: ConnectionProfile) => {
    const edited = await editProfile(existing);
    if (!edited) {
      return;
    }
    const { profile, keepPassword } = edited;
    const password = keepPassword ? await store.getPassword(profile.id) : edited.password;
    try {
      const version = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `VIBE: connecting to ${profile.name}` },
        () => service.test(profile, password),
      );
      void vscode.window.showInformationMessage(`Connected to ${version}.`);
    } catch (err) {
      const choice = await vscode.window.showErrorMessage(`Could not connect: ${errorText(err)}`, { modal: false }, 'Save Anyway', 'Edit');
      if (choice === 'Edit') {
        return saveProfile({ ...profile });
      }
      if (choice !== 'Save Anyway') {
        return;
      }
    }
    await store.save(profile);
    if (!keepPassword) {
      await store.setPassword(profile.id, password);
    }
    await service.disconnect(profile.id);
    tree.refresh();
  };

  const view = vscode.window.createTreeView('vibe.databases', { treeDataProvider: tree, showCollapseAll: true });

  context.subscriptions.push(
    view,
    vscode.commands.registerCommand('vibe.db.addConnection', () => saveProfile()),
    vscode.commands.registerCommand('vibe.db.editConnection', (node?: Node) =>
      node?.type === 'connection' ? saveProfile(node.profile) : undefined,
    ),
    vscode.commands.registerCommand('vibe.db.removeConnection', async (node?: Node) => {
      if (node?.type !== 'connection') {
        return;
      }
      const ok = await vscode.window.showWarningMessage(`Remove the connection "${node.profile.name}" and its saved password?`, { modal: true }, 'Remove');
      if (ok) {
        await service.disconnect(node.profile.id);
        await store.remove(node.profile.id);
        tree.refresh();
      }
    }),
    vscode.commands.registerCommand('vibe.db.disconnect', async (node?: Node) => {
      if (node?.type === 'connection') {
        await service.disconnect(node.profile.id);
        tree.refresh();
      }
    }),
    vscode.commands.registerCommand('vibe.db.refresh', async (node?: Node) => {
      if (node?.type === 'connection') {
        await service.disconnect(node.profile.id);
      }
      tree.refresh(node);
    }),
    vscode.commands.registerCommand('vibe.db.loadTable', async (node?: Node) => {
      if (node?.type !== 'object') {
        return;
      }
      const { profile, obj } = node;
      await runImport(`${obj.schema}.${obj.name}`, (engine, opts) => service.importTable(profile, obj, engine, opts));
    }),
    vscode.commands.registerCommand('vibe.db.newQuery', async (node?: Node) => {
      const profile = node && node.type !== 'message' ? node.profile : await pickConnection('Write a query against');
      if (!profile) {
        return;
      }
      const from = node?.type === 'object' ? `${node.obj.schema}.${node.obj.name}` : node?.type === 'schema' ? `${node.schema}.` : '';
      const content = `-- VIBE connection: ${profile.name}\n-- Run with Ctrl+Enter (Cmd+Enter on macOS). Runs the selection, or the whole editor.\nSELECT *\nFROM ${from}\n`;
      const doc = await vscode.workspace.openTextDocument({ language: 'sql', content });
      queryTargets.set(doc.uri.toString(), profile.id);
      const editor = await vscode.window.showTextDocument(doc);
      const end = doc.lineAt(3).range.end;
      editor.selection = new vscode.Selection(end, end);
    }),
    vscode.commands.registerCommand('vibe.db.runQuery', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        return;
      }
      const doc = editor.document;
      const sql = editor.selection.isEmpty ? doc.getText() : doc.getText(editor.selection);
      if (!sql.replace(/--.*$/gm, '').trim()) {
        void vscode.window.showWarningMessage('VIBE: there is no SQL to run.');
        return;
      }
      // A "-- VIBE connection: name" header lets saved .sql files remember their connection.
      const header = /^--\s*VIBE connection:\s*(.+)$/im.exec(doc.getText())?.[1]?.trim();
      let profile =
        store.list().find((p) => p.id === queryTargets.get(doc.uri.toString())) ?? store.list().find((p) => p.name === header);
      profile ??= await pickConnection('Run the query on');
      if (!profile) {
        return;
      }
      queryTargets.set(doc.uri.toString(), profile.id);
      const target = profile;
      const tableName = `query_${++queryCount}`;
      await runImport(`query on ${target.name}`, (engine, opts) => service.importQuery(target, sql, engine, opts, tableName));
    }),
    vscode.workspace.onDidCloseTextDocument((doc) => queryTargets.delete(doc.uri.toString())),
  );

  return service;
}

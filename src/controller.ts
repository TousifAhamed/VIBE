import * as path from 'node:path';
import { DataEngine } from './engine/engine';
import type { HostMessage, WebviewMessage } from './protocol';

/**
 * Answers webview messages using the data engine. Kept free of the `vscode`
 * module so it can be driven by tests and by the browser preview harness.
 */
export class PanelController {
  constructor(
    private readonly engine: DataEngine,
    private readonly post: (msg: HostMessage) => void,
    private readonly pickFiles: () => Promise<string[]>,
  ) {}

  async loadFiles(files: string[]): Promise<void> {
    let active: string | undefined;
    for (const file of files) {
      this.post({ type: 'loading', file: path.basename(file) });
      try {
        const loaded = await this.engine.loadFile(file);
        active = loaded[0]?.name ?? active;
      } catch (err) {
        this.post({ type: 'error', message: `Could not load ${path.basename(file)}: ${errorText(err)}` });
      }
    }
    this.post({ type: 'tables', tables: this.engine.listTables(), active });
  }

  async handle(msg: WebviewMessage): Promise<void> {
    try {
      switch (msg.type) {
        case 'ready':
          this.post({ type: 'tables', tables: this.engine.listTables() });
          break;
        case 'pickFile': {
          const files = await this.pickFiles();
          if (files.length > 0) {
            await this.loadFiles(files);
          }
          break;
        }
        case 'getRows': {
          const [total, rows] = await Promise.all([
            this.engine.countRows(msg.table, msg.filter),
            this.engine.getRows(msg.table, msg.offset, msg.limit, msg.sort, msg.filter),
          ]);
          this.post({ type: 'rows', reqId: msg.reqId, table: msg.table, offset: msg.offset, total, rows });
          break;
        }
        case 'aggregate': {
          const result = await this.engine.aggregate(msg.table, msg.x, msg.y, msg.agg, msg.orderBy);
          this.post({ type: 'aggregate', reqId: msg.reqId, ...result });
          break;
        }
      }
    } catch (err) {
      this.post({ type: 'error', message: errorText(err) });
    }
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

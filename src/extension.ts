import * as vscode from 'vscode';
import { PanelController } from './controller';
import { DataEngine } from './engine/engine';
import type { HostMessage, WebviewMessage } from './protocol';

let enginePromise: Promise<DataEngine> | undefined;
let panel: DataPanel | undefined;

function getEngine(): Promise<DataEngine> {
  enginePromise ??= DataEngine.create();
  return enginePromise;
}

async function pickFiles(): Promise<string[]> {
  const uris = await vscode.window.showOpenDialog({
    canSelectMany: true,
    openLabel: 'Load',
    filters: { 'Data files': ['csv', 'tsv', 'txt', 'xlsx'] },
  });
  return (uris ?? []).map((u) => u.fsPath);
}

class DataPanel {
  private readonly controller: PanelController;
  private readonly ready: Promise<void>;

  private constructor(
    readonly webview: vscode.WebviewPanel,
    engine: DataEngine,
    extensionUri: vscode.Uri,
  ) {
    this.controller = new PanelController(engine, (m) => this.post(m), pickFiles);
    webview.webview.html = renderHtml(webview.webview, extensionUri);
    let markReady!: () => void;
    this.ready = new Promise((resolve) => (markReady = resolve));
    webview.webview.onDidReceiveMessage((msg: WebviewMessage) => {
      if (msg.type === 'ready') {
        markReady();
      }
      void this.controller.handle(msg);
    });
    webview.onDidDispose(() => (panel = undefined));
  }

  static async show(context: vscode.ExtensionContext): Promise<DataPanel> {
    if (panel) {
      panel.webview.reveal();
      return panel;
    }
    const engine = await getEngine();
    const webview = vscode.window.createWebviewPanel('vibe.dataPanel', 'VIBE Data', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist'), vscode.Uri.joinPath(context.extensionUri, 'media')],
    });
    webview.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'icon.svg');
    panel = new DataPanel(webview, engine, context.extensionUri);
    return panel;
  }

  async loadFiles(files: string[]): Promise<void> {
    await this.ready;
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'VIBE: loading data' },
      () => this.controller.loadFiles(files),
    );
  }

  private post(msg: HostMessage): void {
    if (msg.type === 'error') {
      void vscode.window.showErrorMessage(`VIBE: ${msg.message}`);
    }
    void this.webview.webview.postMessage(msg);
  }
}

function renderHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const nonce = Array.from({ length: 32 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
  const script = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'webview.js'));
  const style = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'panel.css'));
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:;">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${style}">
<title>VIBE Data</title>
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
}

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('vibe.openPanel', () => DataPanel.show(context)),
    vscode.commands.registerCommand('vibe.loadFile', async (uri?: vscode.Uri, selected?: vscode.Uri[]) => {
      const files = selected?.length ? selected.map((u) => u.fsPath) : uri ? [uri.fsPath] : await pickFiles();
      if (files.length === 0) {
        return;
      }
      const p = await DataPanel.show(context);
      await p.loadFiles(files);
    }),
  );
}

export async function deactivate(): Promise<void> {
  if (enginePromise) {
    (await enginePromise).close();
  }
}

/* Copyright (c) Microsoft Corporation. Licensed under the MIT License. */
import '../base/browser/ui/codicons/codiconStyles.js';
import { getCodiconFontCharacters } from '../base/common/codiconsUtil.js';
import { Dialog } from '../base/browser/ui/dialog/dialog.js';
export { Grid, Direction, Sizing } from '../base/browser/ui/grid/grid.js';
export { Event } from '../base/common/event.js';
export { ActionBar } from '../base/browser/ui/actionbar/actionbar.js';
export { Action } from '../base/common/actions.js';

const iconStyle = document.createElement('style');
iconStyle.textContent = Object.entries(getCodiconFontCharacters()).map(([id, code]) => `.codicon-${id}:before { content: "\\${code.toString(16)}"; }`).join('\n');
document.head.append(iconStyle);

/** Native UI dialog without workbench services, commands, or an extension host. */
export async function showDialog(container: HTMLElement, options: {
  title: string; detail?: string; buttons: string[]; cancelId: number;
  inputs?: { placeholder: string; value?: string; type?: 'text' | 'password' }[];
  renderBody?: (container: HTMLElement) => void;
}): Promise<{ button: number; values?: string[] }> {
  const dialog = new Dialog(container, options.title, options.buttons, {
    ...options, type: 'none',
    buttonStyles: { buttonBackground: 'var(--vscode-button-background)', buttonForeground: 'var(--vscode-button-foreground)', buttonHoverBackground: 'var(--vscode-button-hoverBackground)', buttonSecondaryBackground: 'var(--vscode-button-secondaryBackground)', buttonSecondaryForeground: 'var(--vscode-foreground)', buttonSecondaryHoverBackground: 'var(--vscode-list-hoverBackground)', buttonBorder: undefined, buttonSeparator: undefined },
    checkboxStyles: { checkboxBackground: 'var(--vscode-input-background)', checkboxForeground: 'var(--vscode-foreground)', checkboxBorder: 'var(--vscode-widget-border)' },
    inputBoxStyles: { inputBackground: 'var(--vscode-input-background)', inputForeground: 'var(--vscode-foreground)', inputBorder: 'var(--vscode-widget-border)' },
    dialogStyles: { dialogBackground: 'var(--vscode-editorWidget-background)', dialogForeground: 'var(--vscode-foreground)', dialogBorder: 'var(--vscode-widget-border)', dialogShadow: 'var(--vscode-widget-shadow)', errorIconForeground: undefined, warningIconForeground: undefined, infoIconForeground: undefined, textLinkForeground: 'var(--vscode-textLink-foreground)' },
  });
  try { return await dialog.show(); } finally { dialog.dispose(); }
}

/** The UI bundle cannot acquire workbench services or dynamically load an extension host. */
import { expect, it } from 'vitest'
import { verifyWorkbenchSource } from './webwjkj-workbench-source.ts'

it('admits UI primitives and rejects IDE, server, extension, and external dependencies', () => {
  const base = 'vendor/webwjkj/vscode/src/vs/'
  expect(() =>{  verifyWorkbenchSource([base + 'webwjkj/ui.ts', base + 'base/browser/ui/grid/grid.ts', base + 'nls.ts']) }).not.toThrow()
  for (const file of ['workbench/workbench.common.main.ts', 'workbench/contrib/chat/browser/chatService.ts', 'platform/terminal/node/ptyService.ts', 'server/node/server.main.ts', 'editor/editor.all.ts', 'base/node/pfs.ts', 'base/parts/ipc/common/ipc.ts']) {
    expect(() =>{  verifyWorkbenchSource([base + file]) }).toThrow('Non-UI dependency')
  }
  expect(() =>{  verifyWorkbenchSource([base + 'nls.ts'], ['vscode']) }).toThrow('External runtime dependency')
  expect(() =>{  verifyWorkbenchSource([]) }).toThrow('Missing UI source graph')
})

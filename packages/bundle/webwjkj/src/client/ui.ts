/** Typed access to the cloned VS Code UI primitives; no editor or command-service API. */
export interface Disposable {
  dispose(): void
}
/** One native grid view owned by webwjkj. */
export interface View {
  element: HTMLElement
  minimumWidth: number
  maximumWidth: number
  minimumHeight: number
  maximumHeight: number
  onDidChange: unknown
  layout(width: number, height: number): void
}
/** Native grid operations exposed to the application. */
export interface Grid extends Disposable {
  element: HTMLElement
  addView(view: View, size: unknown, reference: View, direction: number): void
  removeView(view: View): void
  layout(width: number, height: number): void
}
/** UI source module, bundled independently of VS Code's workbench runtime. */
export interface Ui {
  Grid: new (view: View) => Grid
  Event: {
    None: unknown
  }
  Direction: {
    Left: number
    Right: number
    Down: number
  }
  Sizing: {
    Distribute: unknown
  }
  Action: new (id: string, label: string, css: string, enabled: boolean, run: () => void) => Disposable
  ActionBar: new (container: HTMLElement, options?: {
    orientation: number
  }) => Disposable & {
    push(action: Disposable, options: {
      icon: boolean
      label: boolean
    }): void
  }
  showDialog(container: HTMLElement, options: {
    title: string
    detail?: string
    buttons: string[]
    cancelId: number
    inputs?: {
      placeholder: string
      value?: string
      type?: 'text' | 'password'
    }[]
    renderBody?: (element: HTMLElement) => void
  }): Promise<{
    button: number
    values?: string[]
  }>
}
/**
 * Create a text-only DOM element; account and message content never becomes HTML.
 * @param tag - element tag.
 * @param className - application styling class.
 * @param text - optional literal text.
 * @returns detached element.
 */
export function node<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag)
  element.className = className
  if (text !== undefined)
    element.textContent = text
  return element
}

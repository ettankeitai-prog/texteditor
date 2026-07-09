import type { TextEditorApi } from "../preload/preload";

declare global {
  interface Window {
    textEditor: TextEditorApi;
  }
}

export {};

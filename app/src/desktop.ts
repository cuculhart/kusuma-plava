// デスクトップ（Electron）ブリッジ — electron/preload.js が
// window.kusumaPlava へ公開するAPIの型付き窓口。
// ブラウザ配布では未定義なので isDesktop でガードする。

export interface KpOpened {
  path: string;
  b64: string;
}

export interface KpApi {
  openDialog: () => Promise<KpOpened | null>;
  saveDialog: (defaultName: string) => Promise<string | null>;
  readFile: (path: string) => Promise<string>;
  writeFile: (path: string, b64: string) => Promise<boolean>;
  setDirty: (dirty: boolean) => void;
  onMenu: (
    cb: (
      action:
        | 'save'
        | 'save-as'
        | 'open'
        | 'new'
        | 'undo'
        | 'redo'
        | 'print'
        | 'about',
    ) => void,
  ) => () => void;
  onSaveForQuit: (cb: () => void) => () => void;
  quitNow: () => void;
  quitAbort: () => void;
  takePendingFile: () => Promise<string | null>;
  onOpenPath: (cb: (path: string) => void) => () => void;
  pathForFile: (file: File) => string;
  platform: string;
}

export const kp = (window as { kusumaPlava?: KpApi }).kusumaPlava;
export const isDesktop = !!kp;

export function u8ToB64(u: Uint8Array): string {
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000)
    s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
}

export function b64ToU8(b64: string): Uint8Array {
  const s = atob(b64);
  const u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
  return u;
}

export const basename = (p: string) => p.split(/[\\/]/).pop() ?? p;

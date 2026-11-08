const { contextBridge, ipcRenderer, webUtils } = require('electron')

contextBridge.exposeInMainWorld('kusumaPlava', {
  // Native file dialogs - data crosses the bridge as base64 strings
  openDialog: () => ipcRenderer.invoke('kp:open-dialog'),
  saveDialog: (defaultName) =>
    ipcRenderer.invoke('kp:save-dialog', defaultName),
  readFile: (p) => ipcRenderer.invoke('kp:read-file', p),
  writeFile: (p, b64) => ipcRenderer.invoke('kp:write-file', p, b64),

  // Dirty flag for the main-process close guard
  setDirty: (d) => ipcRenderer.send('kp:set-dirty', d),

  // Keyboard accelerators forwarded by the main process:
  // 'save' | 'save-as' | 'open'
  onMenu: (callback) => {
    const listener = (event, action) => callback(action)
    ipcRenderer.on('kp-menu', listener)
    return () => ipcRenderer.removeListener('kp-menu', listener)
  },

  // Close-button flow: main asks the renderer to save then quit
  onSaveForQuit: (callback) => {
    const listener = () => callback()
    ipcRenderer.on('kp-save-for-quit', listener)
    return () => ipcRenderer.removeListener('kp-save-for-quit', listener)
  },
  quitNow: () => ipcRenderer.send('kp:quit-now'),
  quitAbort: () => ipcRenderer.send('kp:quit-abort'),

  // Document path handed to the app via CLI arg / exe drop /
  // second instance. The pull variant covers the initial mount
  // (did-finish-load can race React listener registration).
  takePendingFile: () => ipcRenderer.invoke('kp:take-pending-file'),
  onOpenPath: (callback) => {
    const listener = (event, p) => callback(p)
    ipcRenderer.on('kp-open-path', listener)
    return () => ipcRenderer.removeListener('kp-open-path', listener)
  },

  // Real path of a File dropped onto the window (File.path was removed
  // in newer Electron - webUtils is the supported API)
  pathForFile: (file) => webUtils.getPathForFile(file),

  platform: process.platform,
})

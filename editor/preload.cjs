// 页面和主进程之间只开这两个口子。沙盒里的 preload 只能是普通脚本（没有 exports），所以不经过 TypeScript 编译。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('chener', {
  invoke: (cmd, args) => ipcRenderer.invoke('chener', cmd, args),
  on: (channel, cb) => {
    ipcRenderer.on(channel, (_e, data) => cb(data));
  },
});

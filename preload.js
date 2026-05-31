const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("launcher", {
  invoke(channel, payload) {
    return ipcRenderer.invoke(channel, payload);
  }
});

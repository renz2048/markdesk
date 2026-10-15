import { contextBridge } from "electron";

contextBridge.exposeInMainWorld("markdesk", {
  platform: process.platform,
});

import { contextBridge, ipcRenderer } from 'electron';

/**
 * The bridge the window that picks a backend gets.
 *
 * Nothing else in the app needs one: the console is an ordinary web page,
 * served by whichever backend is in use, and talks to it over HTTP the way any
 * browser would. The main process validates everything that comes through here
 * again, so a page cannot smuggle in a backend the app would not accept.
 */
contextBridge.exposeInMainWorld('desktop', {
  getInfo: (): Promise<unknown> => ipcRenderer.invoke('desktop:info'),
  openInBrowser: (): Promise<void> =>
    ipcRenderer.invoke('desktop:open-in-browser'),
  retryBackend: (): Promise<void> =>
    ipcRenderer.invoke('desktop:retry-backend'),
  setBackend: (backend: unknown): Promise<void> =>
    ipcRenderer.invoke('desktop:set-backend', backend),
  // The window that asks about the backend sizes itself to what it is asking,
  // and it is the page that knows how much room its own text took.
  setContentSize: (width: number, height: number): Promise<void> =>
    ipcRenderer.invoke('desktop:set-content-size', width, height),
});

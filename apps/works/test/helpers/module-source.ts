import type { BrowserWindow } from "electron";
import { waitFor } from "./electron";

export const sourceText =
  "document.querySelector('[data-module-source] diffs-container')?.shadowRoot?.querySelector('[contenteditable=true]')?.textContent ?? ''";

export async function openLibrary(window: BrowserWindow) {
  await waitFor(
    () =>
      window.webContents.executeJavaScript(
        "!!document.querySelector('a[href=\"#/modules\"]')"
      ),
    "Library link missing"
  );
  await window.webContents.executeJavaScript(
    "document.querySelector('a[href=\"#/modules\"]').click()"
  );
  await waitFor(
    () =>
      window.webContents.executeJavaScript(
        "!!document.querySelector('#module-name')"
      ),
    "Library did not open"
  );
}

export async function selectManagementView(
  window: BrowserWindow,
  name: string
) {
  await window.webContents.executeJavaScript(
    `Array.from(document.querySelectorAll('[role=tab]')).find(tab => tab.textContent.startsWith(${JSON.stringify(name)})).focus()`
  );
  await waitFor(
    () =>
      window.webContents.executeJavaScript(
        `Array.from(document.querySelectorAll('[role=tab]')).some(tab => tab.textContent.startsWith(${JSON.stringify(name)}) && tab.getAttribute('aria-selected') === 'true')`
      ),
    `Management view ${name} did not open`
  );
}

export async function replaceSource(window: BrowserWindow, contents: string) {
  await waitFor(
    () =>
      window.webContents.executeJavaScript(
        "!!document.querySelector('[data-module-source] diffs-container')?.shadowRoot?.querySelector('[contenteditable=true]')"
      ),
    "Pierre editor did not attach"
  );
  await window.webContents.executeJavaScript(
    "document.querySelector('[data-module-source] diffs-container').shadowRoot.querySelector('[contenteditable=true]').focus()"
  );
  window.webContents.sendInputEvent({
    keyCode: "A",
    modifiers: [process.platform === "darwin" ? "meta" : "control"],
    type: "keyDown",
  });
  window.webContents.sendInputEvent({
    keyCode: "A",
    modifiers: [process.platform === "darwin" ? "meta" : "control"],
    type: "keyUp",
  });
  window.webContents.debugger.attach("1.3");
  try {
    await window.webContents.debugger.sendCommand("Input.insertText", {
      text: contents,
    });
  } finally {
    window.webContents.debugger.detach();
  }
  await waitFor(
    async () =>
      await window.webContents.executeJavaScript(`(() => {
        const id = decodeURIComponent(location.hash.split('/')[2]);
        const path = document.querySelector('[aria-label=Editor] h2').textContent;
        const draft = JSON.parse(localStorage.getItem('module-draft:' + id) ?? 'null');
        return draft?.source[path] === ${JSON.stringify(contents)};
      })()`),
    "Pierre editor did not accept the source edit"
  );
  await waitFor(
    () =>
      window.webContents.executeJavaScript(
        "Array.from(document.querySelectorAll('button')).some(button => button.textContent === 'Save source' && !button.disabled)"
      ),
    "Edited source did not enable Save source"
  );
}

export async function selectSourceFile(window: BrowserWindow, path: string) {
  await window.webContents.executeJavaScript(
    `document.querySelector('file-tree-container').shadowRoot.querySelector('[data-item-path="' + ${JSON.stringify(path)} + '"]').click()`
  );
  await waitFor(
    () =>
      window.webContents.executeJavaScript(
        `document.querySelector('[aria-label=Editor] h2')?.textContent === ${JSON.stringify(path)}`
      ),
    `Tree did not select ${path}`
  );
}

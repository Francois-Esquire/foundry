import type { StorageObserver } from "@foundry/core/storage";
import { DefenseInDepthBox, InMemoryFs } from "just-bash";

export class ObservableFileSystem
  extends InMemoryFs
  implements StorageObserver
{
  private readonly listeners = new Set<() => void>();

  watch(_root: string, changed: () => void) {
    this.listeners.add(changed);
    return Promise.resolve({
      close: () => {
        this.listeners.delete(changed);
        return Promise.resolve();
      },
    });
  }

  private async mutate(operation: () => Promise<void>): Promise<void> {
    try {
      await operation();
    } finally {
      // Host observers may schedule work; shell execution remains guarded.
      DefenseInDepthBox.runTrusted(() => {
        // A failed recursive operation may still have changed part of the tree.
        for (const listener of this.listeners) {
          listener();
        }
      });
    }
  }

  override writeFile(...args: Parameters<InMemoryFs["writeFile"]>) {
    return this.mutate(() => super.writeFile(...args));
  }

  override appendFile(...args: Parameters<InMemoryFs["appendFile"]>) {
    return this.mutate(() => super.appendFile(...args));
  }

  override mkdir(...args: Parameters<InMemoryFs["mkdir"]>) {
    return this.mutate(() => super.mkdir(...args));
  }

  override rm(...args: Parameters<InMemoryFs["rm"]>) {
    return this.mutate(() => super.rm(...args));
  }

  override cp(...args: Parameters<InMemoryFs["cp"]>) {
    return this.mutate(() => super.cp(...args));
  }

  override mv(...args: Parameters<InMemoryFs["mv"]>) {
    return this.mutate(() => super.mv(...args));
  }

  override symlink(...args: Parameters<InMemoryFs["symlink"]>) {
    return this.mutate(() => super.symlink(...args));
  }

  override link(...args: Parameters<InMemoryFs["link"]>) {
    return this.mutate(() => super.link(...args));
  }

  override chmod(...args: Parameters<InMemoryFs["chmod"]>) {
    return this.mutate(() => super.chmod(...args));
  }

  override utimes(...args: Parameters<InMemoryFs["utimes"]>) {
    return this.mutate(() => super.utimes(...args));
  }
}

import type { Storage } from "../filesystem";

/**
 * A fresh root containing kept.txt, nested/value.txt, an empty directory named
 * empty, and a symbolic link named link pointing to kept.txt.
 */
export interface StorageFixture {
  failNextDirectoryRead: () => void;
  failNextReplacement: () => void;
  readonly root: string;
  readonly storage: Storage;
}

interface StorageCheck {
  readonly name: string;
  run(fixture: StorageFixture): Promise<void>;
}

function check(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function sameBytes(actual: Uint8Array, expected: Uint8Array): boolean {
  return (
    actual.length === expected.length &&
    actual.every((byte, index) => byte === expected[index])
  );
}

async function rejects(operation: () => Promise<unknown>): Promise<void> {
  try {
    await operation();
  } catch {
    return;
  }
  throw new Error("Expected storage operation to reject");
}

async function names(storage: Storage, root: string): Promise<string> {
  return (await storage.readDirectory(root))
    .map((entry) => entry.name)
    .sort()
    .join(",");
}

/** Run each check against a fresh fixture using the consumer's test runner. */
export const storageChecks: readonly StorageCheck[] = [
  {
    name: "creates files and round trips UTF-8 text and detached bytes",
    async run({ storage, root }) {
      const textPath = `${root}/created/text.txt`;
      await storage.writeFile(textPath, "café");
      check(
        sameBytes(
          await storage.readFile(textPath),
          new Uint8Array([99, 97, 102, 195, 169])
        ),
        "Text must be UTF-8 encoded"
      );
      const binaryPath = `${root}/created/binary.dat`;
      const bytes = new Uint8Array([0, 1, 127, 255]);
      await storage.writeFile(binaryPath, bytes);
      bytes[0] = 42;
      const read = await storage.readFile(binaryPath);
      check(
        sameBytes(read, new Uint8Array([0, 1, 127, 255])),
        "Storage must own its written bytes"
      );
      read[0] = 99;
      check(
        sameBytes(
          await storage.readFile(binaryPath),
          new Uint8Array([0, 1, 127, 255])
        ),
        "Reading must not expose mutable storage"
      );
    },
  },
  {
    name: "lists immediate children completely without following symbolic links",
    async run({ storage, root }) {
      check(
        (await names(storage, root)) === "empty,kept.txt,link,nested",
        "Directory entries must contain names of immediate children"
      );
      const entries = await storage.readDirectory(root);
      check(
        entries.find((entry) => entry.name === "kept.txt")?.isFile === true,
        "Regular files must be classified"
      );
      check(
        entries.find((entry) => entry.name === "nested")?.isDirectory === true,
        "Directories must be classified"
      );
      const link = entries.find((entry) => entry.name === "link");
      check(
        link?.isSymbolicLink === true && !link.isFile && !link.isDirectory,
        "Listing must inspect a symbolic link itself"
      );
      check(
        (await storage.readDirectory(`${root}/empty`)).length === 0,
        "Empty directories must produce an empty list"
      );
    },
  },
  {
    name: "rejects missing paths and invalid file or directory reads",
    async run({ storage, root }) {
      await rejects(() => storage.readFile(`${root}/missing`));
      await rejects(() => storage.lstat(`${root}/missing`));
      await rejects(() => storage.realpath(`${root}/missing`));
      await rejects(() => storage.readDirectory(`${root}/missing`));
      await rejects(() => storage.readDirectory(`${root}/kept.txt`));
      await rejects(() => storage.readFile(`${root}/nested`));
    },
  },
  {
    name: "inspects symbolic links and resolves their canonical targets",
    async run({ storage, root }) {
      const link = await storage.lstat(`${root}/link`);
      check(
        link.isSymbolicLink && !link.isFile && !link.isDirectory,
        "lstat must not follow the final symbolic link"
      );
      check(
        (await storage.realpath(`${root}/link`)) ===
          (await storage.realpath(`${root}/kept.txt`)),
        "realpath must resolve symbolic links"
      );
      check(
        sameBytes(
          await storage.readFile(`${root}/link`),
          await storage.readFile(`${root}/kept.txt`)
        ),
        "Reads must resolve symbolic links"
      );
    },
  },
  {
    name: "replaces an existing file without leaving staging files",
    async run({ storage, root }) {
      const before = await names(storage, root);
      const bytes = new Uint8Array([0, 128, 255]);
      await storage.replaceFile(`${root}/kept.txt`, bytes);
      check(
        sameBytes(await storage.readFile(`${root}/kept.txt`), bytes),
        "Replacement must preserve exact bytes"
      );
      check(
        (await names(storage, root)) === before,
        "Replacement must leave no staging files"
      );
    },
  },
  {
    name: "refuses replacement of missing files, directories, and symbolic links",
    async run({ storage, root }) {
      const before = await storage.readFile(`${root}/kept.txt`);
      const entries = await names(storage, root);
      for (const name of ["missing", "nested", "link"]) {
        await rejects(() =>
          storage.replaceFile(`${root}/${name}`, new Uint8Array([9]))
        );
      }
      check(
        sameBytes(await storage.readFile(`${root}/kept.txt`), before),
        "Refused replacements must leave the original bytes intact"
      );
      check(
        (await names(storage, root)) === entries,
        "Refused replacements must not change directory entries"
      );
    },
  },
  {
    name: "preserves original bytes and removes staging files when replacement fails",
    async run({ storage, root, failNextReplacement }) {
      const before = await storage.readFile(`${root}/kept.txt`);
      const entries = await names(storage, root);
      failNextReplacement();
      await rejects(() =>
        storage.replaceFile(`${root}/kept.txt`, new Uint8Array([9]))
      );
      check(
        sameBytes(await storage.readFile(`${root}/kept.txt`), before),
        "Failed replacement must leave the original bytes intact"
      );
      check(
        (await names(storage, root)) === entries,
        "Failed replacement must leave no staging files"
      );
    },
  },
  {
    name: "rejects directory observation failures instead of returning a partial list",
    async run(fixture) {
      fixture.failNextDirectoryRead();
      await rejects(() =>
        fixture.storage.readDirectory(`${fixture.root}/nested`)
      );
    },
  },
];

export const RESOURCE_KINDS = [
  "run",
  "session",
  "artifact",
  "sandbox",
] as const;

export type ResourceKind = (typeof RESOURCE_KINDS)[number];

const SHAREABLE: ReadonlySet<ResourceKind> = new Set([
  "run",
  "session",
  "artifact",
]);

export function isResourceKind(value: string): value is ResourceKind {
  return (RESOURCE_KINDS as readonly string[]).includes(value);
}

export interface ResourceRef {
  readonly id: string;
  readonly kind: ResourceKind;
  readonly owner: string;
}

export interface ResourceAssociation {
  readonly associatedAt: string;
  readonly ref: ResourceRef;
  readonly workspace: string;
}

export interface ArtifactShareEvent {
  readonly artifactId: string;
  readonly at: string;
  readonly id: string;
  readonly type: "artifact.shared" | "artifact.unshared";
  readonly workspace: string;
}

export interface AssociationStoreWrite {
  readonly events?: readonly {
    readonly fact: ArtifactShareEvent;
    readonly owner: string;
  }[];
  readonly put?: readonly ResourceAssociation[];
  readonly remove?: readonly Pick<ResourceAssociation, "ref" | "workspace">[];
}

export interface AssociationStore {
  commit(write: AssociationStoreWrite): Promise<void>;
  list(kind: ResourceKind): Promise<readonly ResourceAssociation[]>;
}

interface ResourceDirectory {
  has(ref: ResourceRef): Promise<boolean>;
  registered(id: string): Promise<boolean>;
}

export class ResourceAssociationError extends Error {
  override readonly name = "ResourceAssociationError";
}

interface AssociationUnit {
  readonly directory: ResourceDirectory;
  readonly store: AssociationStore;
}

export type AssociationTransaction = <T>(
  work: (unit: AssociationUnit) => Promise<T>
) => Promise<T>;

export interface ResourceAssociationsOptions {
  readonly now?: () => Date;
  readonly read?: AssociationTransaction;
  readonly transact: AssociationTransaction;
}

export class ResourceAssociations {
  readonly #now: () => Date;
  readonly #read: AssociationTransaction;
  readonly #transact: AssociationTransaction;

  constructor(options: ResourceAssociationsOptions) {
    this.#now = options.now ?? (() => new Date());
    this.#transact = options.transact;
    this.#read = options.read ?? options.transact;
  }

  share(ref: ResourceRef, workspace: string): Promise<boolean> {
    refuseUnshareable(ref.kind);
    this.#refuseOwner(ref, workspace, "shared with");
    return this.#transact(async ({ directory, store }) => {
      if (!(await directory.has(ref))) {
        throw new ResourceAssociationError(
          `no ${ref.kind} ${ref.id} in workspace ${ref.owner}`
        );
      }
      if (!(await directory.registered(workspace))) {
        throw new ResourceAssociationError(`no workspace ${workspace}`);
      }
      if ((await sharedWithIn(store, ref)).includes(workspace)) {
        return false;
      }
      const at = this.#now().toISOString();
      await store.commit({
        ...this.#facts(ref, workspace, "artifact.shared", at),
        put: [{ associatedAt: at, ref, workspace }],
      });
      return true;
    });
  }

  unshare(ref: ResourceRef, workspace: string): Promise<boolean> {
    this.#refuseOwner(ref, workspace, "unshared from");
    return this.#transact(async ({ store }) => {
      if (!(await sharedWithIn(store, ref)).includes(workspace)) {
        return false;
      }
      await store.commit({
        ...this.#facts(
          ref,
          workspace,
          "artifact.unshared",
          this.#now().toISOString()
        ),
        remove: [{ ref, workspace }],
      });
      return true;
    });
  }

  sharedWith(ref: ResourceRef): Promise<readonly string[]> {
    return this.#read(({ store }) => sharedWithIn(store, ref));
  }

  #facts(
    ref: ResourceRef,
    workspace: string,
    type: ArtifactShareEvent["type"],
    at: string
  ): Pick<AssociationStoreWrite, "events"> {
    return ref.kind === "artifact"
      ? {
          events: [
            {
              fact: {
                artifactId: ref.id,
                at,
                id: crypto.randomUUID(),
                type,
                workspace,
              },
              owner: ref.owner,
            },
          ],
        }
      : {};
  }

  #refuseOwner(ref: ResourceRef, workspace: string, verb: string): void {
    if (workspace === ref.owner) {
      throw new ResourceAssociationError(
        `a ${ref.kind} always belongs to the workspace that owns it, and cannot be ${verb} it`
      );
    }
  }
}

export function refuseUnshareable(kind: ResourceKind): void {
  if (!SHAREABLE.has(kind)) {
    throw new ResourceAssociationError(
      `a ${kind} belongs to the workspace that started it and cannot be shared`
    );
  }
}

async function sharedWithIn(
  store: AssociationStore,
  ref: ResourceRef
): Promise<readonly string[]> {
  return (await store.list(ref.kind))
    .filter((association) => sameResource(association.ref, ref))
    .map((association) => association.workspace)
    .sort();
}

export function sameResource(a: ResourceRef, b: ResourceRef): boolean {
  return a.kind === b.kind && a.owner === b.owner && a.id === b.id;
}

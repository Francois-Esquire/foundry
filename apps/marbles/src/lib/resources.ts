/**
 * Resources and the workspaces they belong to.
 *
 * A resource is something Marbles keeps centrally, in one store for its
 * kind: an artifact, a workflow run, an agent session, a sandbox container
 * or a module. Its stable identity is its kind, the workspace that owns it
 * (the scope its store keeps it under, where it was created) and its id
 * there (`ResourceRef`). A resource belongs to its owner from the start and
 * for good; it may also be shared with other workspaces, and those
 * associations are what `ResourceAssociations` keeps. Associations are
 * metadata: removing one never touches the resource, and anything a
 * workspace shows of a resource (a listing, a link on disk) is derived from
 * them.
 */

/** Every kind of resource, in the order listings show them. */
export const RESOURCE_KINDS = [
  "run",
  "session",
  "artifact",
  "sandbox",
  "module",
] as const;

export type ResourceKind = (typeof RESOURCE_KINDS)[number];

/**
 * The kinds a workspace other than the owner may be associated with. A
 * sandbox container is live runtime state driven by the engine of the
 * workspace that started it, so it belongs to that workspace alone.
 */
const SHAREABLE: ReadonlySet<ResourceKind> = new Set([
  "run",
  "session",
  "artifact",
  "module",
]);

export function isResourceKind(value: string): value is ResourceKind {
  return (RESOURCE_KINDS as readonly string[]).includes(value);
}

/** A resource's stable identity. */
export interface ResourceRef {
  /** Its id in its owner's store. */
  readonly id: string;
  readonly kind: ResourceKind;
  /** The workspace whose store keeps it: where it was created. */
  readonly owner: string;
}

/** That `ref` is also shown in `workspace`, since `associatedAt`. */
export interface ResourceAssociation {
  /** ISO time. */
  readonly associatedAt: string;
  readonly ref: ResourceRef;
  readonly workspace: string;
}

/** One atomic write: the removals, then the additions. */
export interface AssociationStoreWrite {
  readonly put?: readonly ResourceAssociation[];
  readonly remove?: readonly Pick<ResourceAssociation, "ref" | "workspace">[];
}

/**
 * Where associations are kept. It enforces nothing: which resources and
 * workspaces exist, and who may be associated, are `ResourceAssociations`'
 * rules. Putting an association already kept keeps the first one.
 */
export interface AssociationStore {
  commit(write: AssociationStoreWrite): Promise<void>;
  /** Every association of `kind`, in no particular order. */
  list(kind: ResourceKind): Promise<readonly ResourceAssociation[]>;
}

/** What the associations are checked against: what exists. */
interface ResourceDirectory {
  /** Whether the owner's store keeps `ref`. */
  has(ref: ResourceRef): Promise<boolean>;
  /** Whether `id` is a workspace this machine has registered. */
  registered(id: string): Promise<boolean>;
}

/** An association the rules refuse; nothing was written. */
export class ResourceAssociationError extends Error {
  override readonly name = "ResourceAssociationError";
}

/**
 * What the rules read and write in one go: the associations and what
 * exists, both inside one transaction, so nothing another writer does
 * lands between a check and the write it allows.
 */
interface AssociationUnit {
  readonly directory: ResourceDirectory;
  readonly store: AssociationStore;
}

/**
 * Run `work` in one transaction over the associations and the stores the
 * resources are kept in, holding off every other writer until it ends, and
 * keep what it wrote only if it resolves.
 */
export type AssociationTransaction = <T>(
  work: (unit: AssociationUnit) => Promise<T>
) => Promise<T>;

export interface ResourceAssociationsOptions {
  readonly now?: () => Date;
  /** Run `work` that only reads, with no write transaction; `transact` when omitted. */
  readonly read?: AssociationTransaction;
  readonly transact: AssociationTransaction;
}

/** The rules of which workspaces a resource belongs to. */
export class ResourceAssociations {
  readonly #now: () => Date;
  readonly #read: AssociationTransaction;
  readonly #transact: AssociationTransaction;

  constructor(options: ResourceAssociationsOptions) {
    this.#now = options.now ?? (() => new Date());
    this.#transact = options.transact;
    this.#read = options.read ?? options.transact;
  }

  /**
   * Show `ref` in `workspace` too. Refused for a kind that belongs to its
   * owner alone, for a resource or workspace that does not exist, and for
   * the owner itself, which the resource always belongs to. Whether it was
   * newly shared: sharing it again changes nothing. The checks and the
   * write are one transaction: a resource deleted meanwhile is either
   * refused or deleted after, taking its share with it.
   */
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
      await store.commit({
        put: [{ associatedAt: this.#now().toISOString(), ref, workspace }],
      });
      return true;
    });
  }

  /**
   * Stop showing `ref` in `workspace`. The resource itself is untouched,
   * whether it still exists or not. Refused for the owner. Whether there
   * was an association to remove; the check and the removal are one
   * transaction.
   */
  unshare(ref: ResourceRef, workspace: string): Promise<boolean> {
    this.#refuseOwner(ref, workspace, "unshared from");
    return this.#transact(async ({ store }) => {
      if (!(await sharedWithIn(store, ref)).includes(workspace)) {
        return false;
      }
      await store.commit({ remove: [{ ref, workspace }] });
      return true;
    });
  }

  /** The workspaces other than its owner `ref` is shared with, by id. */
  sharedWith(ref: ResourceRef): Promise<readonly string[]> {
    // One statement: a read sees one state, and takes no write lock.
    return this.#read(({ store }) => sharedWithIn(store, ref));
  }

  #refuseOwner(ref: ResourceRef, workspace: string, verb: string): void {
    if (workspace === ref.owner) {
      throw new ResourceAssociationError(
        `a ${ref.kind} always belongs to the workspace that owns it, and cannot be ${verb} it`
      );
    }
  }
}

/**
 * Refuse a kind that belongs to its owner alone, before anything is looked
 * up: a caller that finds the resource first checks this first.
 */
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

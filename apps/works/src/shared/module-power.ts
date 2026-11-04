/** Whether a Module is on, and whether its sandbox is live now. */
export interface ModulePowerView {
  readonly moduleId: string;
  /** Off refuses new work and removes its sandbox until turned on again. */
  readonly on: boolean;
  /** A live sandbox; while on it stays up even when idle. */
  readonly sandbox: boolean;
}

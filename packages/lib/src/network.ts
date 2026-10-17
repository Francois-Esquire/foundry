/**
 * The shape of one network destination a sandbox may reach, shared by the
 * Module Manifest's `network` request and the sandbox destination
 * allowlist, so an approved request is the allowlist entry unchanged.
 */

/** A lowercase DNS host name: dot-separated labels, never an IP address. */
export const DNS_HOST_NAME_PATTERN =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export const DNS_HOST_NAME_MAX_LENGTH = 253;

export const PORT_MIN = 1;
export const PORT_MAX = 65_535;

/** At most this many ports per destination. */
export const DESTINATION_PORTS_MAX = 32;

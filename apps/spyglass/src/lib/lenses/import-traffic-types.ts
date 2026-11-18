export const IMPORT_TRAFFIC_SCHEMA_VERSION = 1;

export interface ImportTrafficPair {
  consumerFiles: string[];
  from: string;
  supplierFiles: string[];
  to: string;
}

export interface ImportTraffic {
  pairs: ImportTrafficPair[];
}

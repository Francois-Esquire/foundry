export interface SatelliteState {
  id: string;
}

export function launchSatellite(): SatelliteState {
  return recalibrate();
}

export function recalibrate(): SatelliteState {
  return { id: "recalibrated" };
}

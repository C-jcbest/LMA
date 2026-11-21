export interface Coordinates {
  latitude: number;
  longitude: number;
}

export function validCoordinates(location: { latitude?: number | null; longitude?: number | null } | null | undefined): location is Coordinates {
  const latitude = location?.latitude;
  const longitude = location?.longitude;
  return typeof latitude === 'number' && Number.isFinite(latitude) && Math.abs(latitude) <= 90
    && typeof longitude === 'number' && Number.isFinite(longitude) && Math.abs(longitude) <= 180;
}

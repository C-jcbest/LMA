export interface Coordinates {
  latitude: number;
  longitude: number;
}

/** 上游有经纬度填反的记录；拒绝非法范围，不猜测或改写原始坐标。 */
export function validCoordinates(location: { latitude?: number | null; longitude?: number | null } | null | undefined): location is Coordinates {
  const latitude = location?.latitude;
  const longitude = location?.longitude;
  return typeof latitude === 'number' && Number.isFinite(latitude) && Math.abs(latitude) <= 90
    && typeof longitude === 'number' && Number.isFinite(longitude) && Math.abs(longitude) <= 180;
}

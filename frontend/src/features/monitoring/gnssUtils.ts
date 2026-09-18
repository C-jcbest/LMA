export const toFiniteGnssNumber = (value: unknown): number | null => {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

export const formatGnssValue = (value: unknown): string => {
  const parsed = toFiniteGnssNumber(value);
  return parsed === null ? '—' : parsed.toFixed(3);
};

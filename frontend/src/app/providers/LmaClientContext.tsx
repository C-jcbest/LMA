import { createContext, useContext } from 'react';
import type { LmaClient } from '@/services/api';

export const LmaClientContext = createContext<LmaClient | null>(null);

export function useLmaClient(): LmaClient {
  const client = useContext(LmaClientContext);
  if (!client) {
    throw new Error('LmaClientContext is required');
  }
  return client;
}

export const FocusStationContext = createContext<((stationName: string | null) => void) | null>(null);

export function useSetFocusStation() {
  const setFocusStation = useContext(FocusStationContext);
  if (!setFocusStation) {
    throw new Error('FocusStationContext is required');
  }
  return setFocusStation;
}

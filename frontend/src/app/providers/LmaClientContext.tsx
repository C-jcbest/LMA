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

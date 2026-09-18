import React from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from 'sonner';
import { queryClient } from './queryClient';
import { TooltipProvider } from '../components/ui/tooltip';
import { LangGraphClientProvider } from '../lib/langgraph';

export const AppProviders: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  return (
    <QueryClientProvider client={queryClient}>
      <LangGraphClientProvider>
        <TooltipProvider delayDuration={200}>
          {children}
          <Toaster position="top-right" richColors closeButton />
        </TooltipProvider>
      </LangGraphClientProvider>
    </QueryClientProvider>
  );
};

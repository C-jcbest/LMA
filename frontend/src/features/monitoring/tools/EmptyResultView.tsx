import React from 'react';

export const EmptyResultView: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="px-0.5 py-2 text-xs text-muted-foreground" role="status">
    {children}
  </div>
);

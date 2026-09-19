import React from 'react';

interface MarkdownMessageProps {
  content: string;
}

export const MarkdownMessage: React.FC<MarkdownMessageProps> = ({ content }) => {
  return (
    <div className="prose message-markdown text-sm break-words leading-relaxed whitespace-pre-wrap">
      {content}
    </div>
  );
};

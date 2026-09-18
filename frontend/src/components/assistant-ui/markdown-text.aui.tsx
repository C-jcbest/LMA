import React from 'react';
import { MarkdownTextPrimitive } from '@assistant-ui/react-markdown';
import remarkGfm from 'remark-gfm';

const MarkdownComponents: React.ComponentProps<typeof MarkdownTextPrimitive>['components'] = {
  table: ({ children, ...props }) => (
    <div className="my-2.5 w-full overflow-x-auto rounded-lg border border-neutral-200 shadow-2xs">
      <table className="w-full border-collapse text-left text-xs" {...props}>
        {children}
      </table>
    </div>
  ),
  thead: ({ children, ...props }) => (
    <thead className="bg-neutral-50/90 text-neutral-700 font-semibold border-b border-neutral-200" {...props}>
      {children}
    </thead>
  ),
  th: ({ children, ...props }) => (
    <th className="py-2 px-3 whitespace-nowrap font-medium text-neutral-800" {...props}>
      {children}
    </th>
  ),
  td: ({ children, ...props }) => (
    <td className="py-2 px-3 border-b border-neutral-100 text-neutral-700" {...props}>
      {children}
    </td>
  ),
  blockquote: ({ children, ...props }) => (
    <blockquote className="my-2 border-l-3 border-neutral-300 pl-3.5 py-0.5 text-neutral-600 italic" {...props}>
      {children}
    </blockquote>
  ),
  a: ({ children, href, ...props }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-indigo-600 underline underline-offset-2 hover:text-indigo-800 font-medium"
      {...props}
    >
      {children}
    </a>
  ),
  code: ({ children, className, ...props }) => {
    return (
      <code
        className="rounded bg-neutral-100 px-1.5 py-0.5 font-mono text-[11px] text-neutral-800"
        {...props}
      >
        {children}
      </code>
    );
  },
  pre: ({ children, ...props }) => (
    <pre className="my-2.5 overflow-x-auto rounded-lg border border-neutral-200 bg-neutral-50 p-3 font-mono text-xs text-neutral-800" {...props}>
      {children}
    </pre>
  ),
};

export const MarkdownText: React.FC = () => {
  return (
    <div className="message-markdown text-neutral-800 text-sm leading-relaxed">
      <MarkdownTextPrimitive
        remarkPlugins={[remarkGfm]}
        components={MarkdownComponents}
      />
    </div>
  );
};

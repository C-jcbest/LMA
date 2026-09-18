import React, { useRef, useState, useEffect } from 'react';
import { ArrowDown } from 'lucide-react';

interface ThreadViewportProps {
  children: React.ReactNode;
  dependencies: any[];
}

export const ThreadViewport: React.FC<ThreadViewportProps> = ({
  children,
  dependencies,
}) => {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const isPinnedRef = useRef(true);
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);

  const scrollToBottom = (smooth = true) => {
    messagesEndRef.current?.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto' });
  };

  const handleScroll = () => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    isPinnedRef.current = distance < 80;
    setShowJumpToBottom(distance > 200);
  };

  const handleJumpToBottom = () => {
    isPinnedRef.current = true;
    setShowJumpToBottom(false);
    scrollToBottom();
  };

  useEffect(() => {
    // 仅当用户停留在底部附近时自动跟随滚动，流式输出不打断用户上翻回看
    if (isPinnedRef.current) {
      scrollToBottom();
    }
  }, dependencies);

  return (
    <div className="flex-1 relative overflow-hidden flex flex-col">
      <div
        ref={scrollContainerRef}
        onScroll={handleScroll}
        aria-label="对话消息"
        className="flex-1 overflow-y-auto px-6 py-2 space-y-6"
      >
        {children}
        <div ref={messagesEndRef} />
      </div>

      {showJumpToBottom && (
        <button
          type="button"
          onClick={handleJumpToBottom}
          title="回到底部"
          aria-label="回到底部"
          className="absolute bottom-4 left-1/2 -translate-x-1/2 w-9 h-9 rounded-full bg-white border border-neutral-200 shadow-md flex items-center justify-center text-neutral-500 hover:text-neutral-800 hover:border-neutral-300 transition-colors z-20 cursor-pointer"
        >
          <ArrowDown className="w-4 h-4" />
        </button>
      )}
    </div>
  );
};

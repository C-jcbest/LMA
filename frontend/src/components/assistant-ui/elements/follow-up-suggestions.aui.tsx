"use client";

import { useAuiState, ThreadPrimitive } from "@assistant-ui/react";
import { useLangChainState } from "@assistant-ui/react-langchain";
import { useCallback, useEffect, useRef, useState, type FC } from "react";

type RecommendationState = string[];

const FollowupSuggestionsRow: FC = () => {
  const recommendations = useLangChainState<RecommendationState>(
    "recommendations",
    [],
  );
  const suggestions = recommendations
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((prompt) => ({ prompt: prompt.trim(), title: prompt.trim() }));
  const scrollRef = useRef<HTMLDivElement>(null);
  const rtlRef = useRef<boolean | null>(null);
  const [fades, setFades] = useState({ left: false, right: false });

  const updateFades = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const maxScroll = el.scrollWidth - el.clientWidth;
    const fromStart = Math.abs(el.scrollLeft);
    const rtl = (rtlRef.current ??= getComputedStyle(el).direction === "rtl");
    const [left, right] = rtl
      ? [maxScroll - fromStart, fromStart]
      : [fromStart, maxScroll - fromStart];
    setFades((prev) => {
      const next = { left: left > 1, right: right > 1 };
      return prev.left === next.left && prev.right === next.right ? prev : next;
    });
  }, []);

  useEffect(() => {
    updateFades();
    const el = scrollRef.current;
    if (!el?.firstElementChild) return undefined;
    const observer = new ResizeObserver(updateFades);
    observer.observe(el);
    observer.observe(el.firstElementChild);
    return () => observer.disconnect();
  }, [suggestions.length, updateFades]);

  const maskImage = `linear-gradient(to right, ${
    fades.left ? "transparent, black 2rem" : "black"
  }, ${fades.right ? "black calc(100% - 2rem), transparent" : "black"})`;

  if (suggestions.length === 0) return null;

  return (
    <div
      ref={scrollRef}
      onScroll={updateFades}
      data-slot="aui-thread-followup-suggestions"
      className="-my-1 w-full [scrollbar-width:none] overflow-x-auto py-1 [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden"
      style={{ maskImage, WebkitMaskImage: maskImage }}
    >
      <div className="mx-auto flex min-h-8 w-max items-center gap-2 px-0.5">
        {suggestions.map((suggestion) => (
          <ThreadPrimitive.Suggestion
            key={suggestion.prompt}
            className="border-foreground/10 hover:bg-foreground/[0.03] hover:border-foreground/25 rounded-md border px-2.5 py-1 text-sm whitespace-nowrap transition-colors ease-in motion-reduce:transition-none"
            prompt={suggestion.prompt}
            send
          >
            {suggestion.title}
          </ThreadPrimitive.Suggestion>
        ))}
      </div>
    </div>
  );
};

export const ThreadFollowupSuggestions: FC = () => {
  const isRunning = useAuiState((state) => state.thread.isRunning);
  if (isRunning) return null;
  return <FollowupSuggestionsVisibility />;
};

const FollowupSuggestionsVisibility: FC = () => {
  const recommendations = useLangChainState<RecommendationState>(
    "recommendations",
    [],
  );
  const hasRecommendations = recommendations.some(
    (item) => typeof item === "string" && item.trim().length > 0,
  );

  if (!hasRecommendations) return null;
  return <FollowupSuggestionsRow />;
};

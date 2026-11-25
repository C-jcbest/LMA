"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useSessionUndo } from "@/components/ui/motion-primitives";
import { Skeleton } from "@/components/ui/skeleton";
import {
  matchesSessionStatusFilter,
  useSessionVerdict,
  useSessionVerdicts,
  type SessionStatusFilter,
} from "@/features/records/SessionConclusions";
import { investigationStatusLabel } from "@/features/monitoring/investigation";
import { StatusDot } from "@/features/monitoring/status";
import { RecordSearchResults } from "@/features/records/RecordSearchResults";
import { cn } from 'cn';
import { useIsSessionUnread, useRunCompletionNotice } from "@/features/notifications/run-completion";
import {
  AuiIf,
  ThreadListItemMorePrimitive,
  ThreadListItemPrimitive,
  ThreadListPrimitive,
  useAui,
  useAuiState,
} from "@assistant-ui/react";
import {
  AlertCircleIcon,
  Loader2Icon,
  MoreHorizontalIcon,
  PencilIcon,
  SearchIcon,
  TrashIcon,
} from "lucide-react";
import {
  createContext,
  forwardRef,
  Fragment,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type FC,
} from "react";

export const ThreadListLoadError: FC = () => {
  const aui = useAui();
  const hasLoadError = useAuiState((state) => state.threads.loadError != null);
  const isLoading = useAuiState((state) => state.threads.isLoading);

  if (!hasLoadError) return null;

  return (
    <div role="alert" className="flex shrink-0 items-start gap-2 border-b border-destructive/20 bg-destructive/5 px-4 py-3 text-sm">
      <AlertCircleIcon className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="font-medium">会话列表尚未载入</p>
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={isLoading}
        onClick={() => {
          void aui.threads().reload();
        }}
      >
        重试
      </Button>
    </div>
  );
};

const ThreadListNavigationContext = createContext<(() => void) | undefined>(undefined);

type ThreadListVariant = "recent" | "all";
const ThreadListVariantContext = createContext<ThreadListVariant>("all");
const RECENT_THREAD_COUNT = 6;

export const ThreadList: FC<{
  variant: ThreadListVariant;
  statusFilter?: SessionStatusFilter;
  onNavigate?: () => void;
}> = ({ variant, statusFilter = "all", onNavigate }) => {
  const [search, setSearch] = useState("");
  const hasThreads = useAuiState((s) => s.threads.threadIds.length > 0);

  return (
    <ThreadListNavigationContext.Provider value={onNavigate}>
      <ThreadListVariantContext.Provider value={variant}>
        <ThreadListRoot>
          {variant === "all" && (
            <ThreadListSearch value={search} onValueChange={setSearch} />
          )}
          <div
            data-slot="aui_thread-list-viewport"
            className={cn(
              "min-h-0 flex-1 overflow-y-auto overscroll-contain",
              variant === "all" && "[scrollbar-gutter:stable]",
            )}
          >
            {variant === "recent" ? (
              <RecentThreadListItems />
            ) : search.trim() ? (
              <RecordSearchResults query={search.trim()} statusFilter={statusFilter} onOpen={onNavigate} />
            ) : (
              <>
                <ThreadListItems searchQuery={hasThreads ? search : ""} statusFilter={statusFilter} />
                <ThreadListPagination autoLoad={!search.trim() && statusFilter === "all"} />
              </>
            )}
          </div>
        </ThreadListRoot>
      </ThreadListVariantContext.Provider>
    </ThreadListNavigationContext.Provider>
  );
};

const RecentThreadListItems: FC = () => {
  const threadIds = useAuiState((s) => s.threads.threadIds);
  const isLoading = useAuiState((s) => s.threads.isLoading);

  if (isLoading && threadIds.length === 0) {
    return <ThreadListSkeleton />;
  }
  return (
    <div data-slot="aui_thread-list-items" className="flex flex-col gap-0.5">
      {threadIds.slice(0, RECENT_THREAD_COUNT).map((threadId, index) => (
        <ThreadListPrimitive.ItemByIndex key={threadId} index={index} components={{ ThreadListItem }} />
      ))}
    </div>
  );
};

const ThreadListPagination: FC<{ autoLoad: boolean }> = ({ autoLoad }) => {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const hasMore = useAuiState((s) => s.threads.hasMore);
  const isLoading = useAuiState((s) => s.threads.isLoading);
  const isLoadingMore = useAuiState((s) => s.threads.isLoadingMore);
  const loadedCount = useAuiState((s) => s.threads.threadItems.length);

  useEffect(() => {
    const button = buttonRef.current;
    if (!autoLoad || !hasMore || isLoading || !button) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting && !button.disabled) {
          observer.disconnect();
          button.click();
        }
      },
      { root: button.parentElement, rootMargin: "0px 0px 120px 0px" },
    );
    observer.observe(button);
    return () => observer.disconnect();
  }, [autoLoad, hasMore, isLoading, loadedCount]);

  if (isLoading || !hasMore) return null;
  return (
    <ThreadListPrimitive.LoadMore asChild>
      <Button
        ref={buttonRef}
        variant="ghost"
        className="mt-1 w-full cursor-pointer text-xs text-muted-foreground hover:text-foreground"
        aria-busy={isLoadingMore}
      >
        {isLoadingMore && <Loader2Icon className="size-3.5 animate-spin" aria-hidden="true" />}
        {isLoadingMore ? "正在加载会话…" : "加载更多会话"}
      </Button>
    </ThreadListPrimitive.LoadMore>
  );
};

export const ThreadListSearch = forwardRef<
  HTMLInputElement,
  Omit<ComponentPropsWithoutRef<typeof Input>, "value" | "onChange"> & {
    value: string;
    onValueChange: (value: string) => void;
  }
>(({ className, value, onValueChange, ...props }, ref) => {
  return (
    <div data-slot="aui_thread-list-search" className="relative mb-3 shrink-0 px-0.5">
      <SearchIcon
        data-slot="aui_thread-list-search-icon"
        className="text-muted-foreground pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2"
      />
      <Input
        ref={ref}
        type="search"
        value={value}
        onChange={(event) => onValueChange(event.target.value)}
        aria-label="搜索会话"
        placeholder="搜索标题或测点"
        className={cn(
          "h-9 border-transparent bg-muted ps-8 text-sm shadow-none focus-visible:bg-background",
          className,
        )}
        {...props}
      />
    </div>
  );
});

ThreadListSearch.displayName = "ThreadListSearch";

export const ThreadListRoot: FC<
  ComponentPropsWithoutRef<typeof ThreadListPrimitive.Root>
> = ({ className, ...props }) => {
  return (
    <ThreadListPrimitive.Root
      data-slot="aui_thread-list-root"
      className={cn("flex h-full min-h-0 flex-col gap-0.5", className)}
      {...props}
    />
  );
};

export const ThreadListItems: FC<
  ComponentPropsWithoutRef<"div"> & { searchQuery?: string; statusFilter?: SessionStatusFilter }
> = ({ className, searchQuery = "", statusFilter = "all", ...props }) => {
  return (
    <div
      data-slot="aui_thread-list-items"
      className={cn("flex flex-col gap-0.5", className)}
      {...props}
    >
      <AuiIf condition={(s) => s.threads.isLoading && s.threads.threadIds.length === 0}>
        <ThreadListSkeleton />
      </AuiIf>
      <AuiIf condition={(s) => !s.threads.isLoading || s.threads.threadIds.length > 0}>
        <ThreadListItemGroups searchQuery={searchQuery} statusFilter={statusFilter} />
      </AuiIf>
    </div>
  );
};

const DAY_IN_MS = 86_400_000;

const dateGroupLabel = (
  date: Date | undefined,
  startOfToday: number,
): string => {
  if (!date || date.getTime() >= startOfToday) return "今天";
  if (date.getTime() >= startOfToday - DAY_IN_MS) return "昨天";
  return "更早";
};

export type ThreadListGroup = { label: string; indices: number[] };

export const useThreadListGroups = (searchQuery = "", statusFilter: SessionStatusFilter = "all") => {
  const threadIds = useAuiState((s) => s.threads.threadIds);
  const threadItems = useAuiState((s) => s.threads.threadItems);
  const verdicts = useSessionVerdicts();

  const query = searchQuery.trim().toLowerCase();

  return useMemo(() => {
    const itemsById = new Map(threadItems.map((item) => [item.id, item]));
    const dates = threadIds.map((id) => itemsById.get(id)?.lastMessageAt);
    const filteredIndices = threadIds
      .map((id, index) => ({ id, index }))
      .filter(({ id }) => {
        const item = itemsById.get(id);
        const matchesQuery =
          !query || (item?.title || "新会话").toLowerCase().includes(query);
        const matchesStatus = matchesSessionStatusFilter(
          verdicts.get(item?.remoteId ?? id),
          statusFilter,
        );
        return matchesQuery && matchesStatus;
      })
      .map(({ index }) => index);
    if (!filteredIndices.some((index) => dates[index])) {
      return { threadIds, filteredIndices, groups: null };
    }

    const now = new Date();
    const startOfToday = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
    ).getTime();
    const time = (index: number) =>
      dates[index]?.getTime() ?? Number.MAX_SAFE_INTEGER;
    const sorted = [...filteredIndices].sort((a, b) => time(b) - time(a));

    const result: ThreadListGroup[] = [];
    for (const index of sorted) {
      const label = dateGroupLabel(dates[index], startOfToday);
      const lastGroup = result[result.length - 1];
      if (lastGroup?.label === label) {
        lastGroup.indices.push(index);
      } else {
        result.push({ label, indices: [index] });
      }
    }
    return { threadIds, filteredIndices, groups: result };
  }, [threadIds, threadItems, verdicts, query, statusFilter]);
};

const ThreadListItemGroups: FC<{ searchQuery?: string; statusFilter?: SessionStatusFilter }> = ({
  searchQuery = "",
  statusFilter = "all",
}) => {
  const { threadIds, filteredIndices, groups } =
    useThreadListGroups(searchQuery, statusFilter);
  const hasLoadError = useAuiState((s) => s.threads.loadError != null);
  const query = searchQuery.trim();

  if (threadIds.length === 0) {
    return (
      <div
        data-slot="aui_thread-list-empty"
        className="text-muted-foreground px-2.5 py-4 text-sm"
      >
        {hasLoadError ? "记录尚未载入，可在页面顶部重试。" : "还没有调查记录。"}
      </div>
    );
  }

  if ((query || statusFilter !== "all") && filteredIndices.length === 0) {
    return (
      <div
        data-slot="aui_thread-list-empty"
        className="text-muted-foreground px-2.5 py-4 text-sm"
      >
        已加载的记录中未找到匹配项
      </div>
    );
  }

  if (!groups) {
    return filteredIndices.map((index) => (
      <ThreadListPrimitive.ItemByIndex
        key={threadIds[index]}
        index={index}
        components={{ ThreadListItem }}
      />
    ));
  }

  return groups.map((group) => (
    <Fragment key={group.label}>
      <div
        data-slot="aui_thread-list-group-label"
        className="text-muted-foreground px-2.5 pt-3 pb-1 text-xs font-medium"
      >
        {group.label}
      </div>
      {group.indices.map((index) => (
        <ThreadListPrimitive.ItemByIndex
          key={threadIds[index]}
          index={index}
          components={{ ThreadListItem }}
        />
      ))}
    </Fragment>
  ));
};

const ThreadListSkeleton: FC = () => {
  return (
    <div className="flex flex-col gap-0.5">
      {Array.from({ length: 5 }, (_, i) => (
        <div
          key={i}
          role="status"
          aria-label="正在加载会话"
          data-slot="aui_thread-list-skeleton-wrapper"
          className="flex h-8 items-center px-2.5"
        >
          <Skeleton
            data-slot="aui_thread-list-skeleton"
            className="h-3.5 w-full"
          />
        </div>
      ))}
    </div>
  );
};

export const ThreadListItem: FC = () => {
  const aui = useAui();
  const onNavigate = useContext(ThreadListNavigationContext);
  const variant = useContext(ThreadListVariantContext);
  const { pendingIds, scheduleDelete } = useSessionUndo();
  const itemId = useAuiState((s) => s.threadListItem.id);
  const isRunning = useAuiState((s) => s.threadListItem.isRunning);
  const remoteId = useAuiState((s) => s.threadListItem.remoteId);
  const lastMessageAt = useAuiState((s) => s.threadListItem.lastMessageAt);
  const isOpen = useAuiState((s) => s.threads.mainThreadId === s.threadListItem.id);
  const verdict = useSessionVerdict(remoteId);
  const title = useAuiState((s) => s.threadListItem.title);
  useRunCompletionNotice(remoteId, isRunning, isOpen, title);
  const isUnread = useIsSessionUnread(remoteId);
  const [isRenaming, setIsRenaming] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const restoreFocusRef = useRef(false);
  const isPendingDelete = pendingIds.has(itemId);

  useEffect(() => {
    if (isRenaming || !restoreFocusRef.current) return;
    restoreFocusRef.current = false;
    triggerRef.current?.focus();
  }, [isRenaming]);

  return (
    <ThreadListItemPrimitive.Root
      data-slot="aui_thread-list-item"
      aria-hidden={isPendingDelete || undefined}
      className={cn(
        "group hover:bg-muted focus-visible:bg-muted data-active:bg-muted has-focus-visible:bg-muted has-data-[state=open]:bg-muted relative flex items-center overflow-hidden rounded-md transition-[height,opacity,background-color] duration-200 focus-visible:outline-none",
        variant === "all" ? "h-11" : "h-8",
        isPendingDelete && "pointer-events-none h-0 opacity-0",
      )}
    >
      {isRenaming ? (
        <ThreadListItemRename
          onDone={(restoreFocus) => {
            restoreFocusRef.current = restoreFocus;
            setIsRenaming(false);
          }}
        />
      ) : (
        <ThreadListItemPrimitive.Trigger
          ref={triggerRef}
          tabIndex={isPendingDelete ? -1 : undefined}
          onClick={() => {
            onNavigate?.();
          }}
          data-slot="aui_thread-list-item-trigger"
          className="flex h-full min-w-0 flex-1 items-center rounded-md ps-2.5 pe-9 text-start text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {isRunning ? (
            <Loader2Icon
              aria-hidden
              data-slot="aui_thread-list-item-running"
              className={cn(
                "text-muted-foreground size-3.5 shrink-0 animate-spin",
                variant === "recent" ? "ms-0.5 me-2.5" : "me-2",
              )}
            />
          ) : (
            <StatusDot
              status={verdict?.status}
              className={cn(variant === "recent" ? "ms-1 me-3.5" : "me-2.5", !verdict && "invisible")}
            />
          )}
          <span
            data-slot="aui_thread-list-item-title"
            className={cn("min-w-0 flex-1 truncate", isUnread && "text-foreground font-semibold")}
          >
            <ThreadListItemPrimitive.Title fallback="新会话" />
          </span>
          {isRunning && <span className="sr-only">运行中</span>}
          {isUnread && <span className="sr-only">调查已完成，未查看</span>}
          {variant === "all" && verdict && (
            <span
              data-slot="aui_thread-list-item-verdict"
              className="text-muted-foreground ms-3 max-w-2/5 shrink-0 truncate text-xs"
            >
              {verdict.stations.join("、")} · {investigationStatusLabel(verdict.status)}
            </span>
          )}
          {variant === "all" && lastMessageAt && (
            <time
              className="text-muted-foreground ms-3 shrink-0 text-xs tabular-nums"
              dateTime={lastMessageAt.toISOString()}
            >
              {new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric" }).format(lastMessageAt)}
            </time>
          )}
        </ThreadListItemPrimitive.Trigger>
      )}
      <ThreadListItemMore
        isRunning={isRunning}
        onRename={() => setIsRenaming(true)}
        onDelete={() => {
          scheduleDelete(itemId, title || "新会话", () => Promise.resolve(aui.threadListItem().delete()));
        }}
      />
    </ThreadListItemPrimitive.Root>
  );
};

const ThreadListItemRename: FC<{
  onDone: (restoreFocus: boolean) => void;
}> = ({ onDone }) => {
  const aui = useAui();
  const title = useAuiState((s) => s.threadListItem.title) ?? "";
  const [value, setValue] = useState(title);
  const inputRef = useRef<HTMLInputElement>(null);
  const settledRef = useRef(false);

  useEffect(() => {
    inputRef.current?.select();
  }, []);

  const commit = (restoreFocus: boolean) => {
    if (settledRef.current) return;
    settledRef.current = true;

    const next = value.trim();
    if (!next || next === title) {
      onDone(restoreFocus);
      return;
    }

    Promise.resolve()
      .then(() => aui.threadListItem.rename(next))
      .then(
        () => onDone(restoreFocus),
        () => {
          settledRef.current = false;
          if (restoreFocus) inputRef.current?.focus();
        },
      );
  };

  const cancel = () => {
    if (settledRef.current) return;
    settledRef.current = true;
    onDone(true);
  };

  return (
    <Input
      ref={inputRef}
      autoFocus
      data-slot="aui_thread-list-item-rename"
      aria-label="重命名会话"
      value={value}
      className="h-7 min-w-0 flex-1 ps-2.5 pe-9 text-sm"
      onChange={(event) => setValue(event.target.value)}
      onBlur={() => commit(false)}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          commit(true);
        } else if (event.key === "Escape") {
          event.preventDefault();
          cancel();
        }
      }}
    />
  );
};

const ThreadListItemMore: FC<{
  isRunning: boolean;
  onRename: () => void;
  onDelete: () => void;
}> = ({ isRunning, onRename, onDelete }) => {
  return (
    <ThreadListItemMorePrimitive.Root sharedFocusGroup>
      <ThreadListItemMorePrimitive.Trigger asChild>
        <Button
          variant="ghost"
          size="icon"
          data-slot="aui_thread-list-item-more"
          className="data-[state=open]:bg-accent absolute end-1.5 top-1/2 size-6 -translate-y-1/2 p-0 opacity-0 group-hover:opacity-100 group-has-focus-visible:opacity-100 group-data-active:opacity-100 data-[state=open]:opacity-100"
        >
          <MoreHorizontalIcon className="size-3.5" />
          <span className="sr-only">更多选项</span>
        </Button>
      </ThreadListItemMorePrimitive.Trigger>
      <ThreadListItemMorePrimitive.Content
        side="right"
        align="start"
        sideOffset={6}
        data-slot="aui_thread-list-item-more-content"
        className="bg-popover text-popover-foreground data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=closed]:animate-out data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 min-w-32 overflow-hidden rounded-xl border p-1.5"
      >
        <ThreadListItemMorePrimitive.Item
          data-slot="aui_thread-list-item-more-item"
          className="hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm outline-none select-none"
          onSelect={onRename}
        >
          <PencilIcon className="size-4" />
          重命名
        </ThreadListItemMorePrimitive.Item>
        <ThreadListItemMorePrimitive.Item
          disabled={isRunning}
          data-slot="aui_thread-list-item-more-item"
          title={isRunning ? "分析进行中，暂不可删除" : undefined}
          className="text-destructive hover:bg-destructive/10 hover:text-destructive focus:bg-destructive/10 focus:text-destructive flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm outline-none select-none data-disabled:pointer-events-none data-disabled:opacity-45"
          onSelect={() => {
            if (!isRunning) {
              onDelete();
            }
          }}
        >
          <TrashIcon className="size-4" />
          {isRunning ? "运行中不可删除" : "删除"}
        </ThreadListItemMorePrimitive.Item>
      </ThreadListItemMorePrimitive.Content>
    </ThreadListItemMorePrimitive.Root>
  );
};

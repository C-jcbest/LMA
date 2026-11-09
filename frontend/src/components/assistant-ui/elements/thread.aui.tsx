"use client";

import { MarkdownText } from "@/components/markdown-text";
import { TooltipIconButton } from "@/components/tooltip-icon-button";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ContextUsageElement } from "@/components/assistant-ui/elements/context-usage.aui";
import {
  InvestigationIndicator,
  InvestigationProcess,
} from "@/features/monitoring/InvestigationProcess";
import { InvestigationReport, ReportActions } from "@/features/monitoring/InvestigationReport";
import { useStationInspector } from "@/features/monitoring/StationInspectorContext";
import { findReport } from "@/features/monitoring/investigation";
import { TodayAttention } from "@/features/today/TodayAttention";
import { cn } from "@/lib/utils";
import { useSessionMetadata } from "@/lib/session-metadata";
import {
  ActionBarPrimitive,
  AuiIf,
  type AssistantState,
  ComposerPrimitive,
  ErrorPrimitive,
  groupPartByType,
  MessagePrimitive,
  ThreadPrimitive,
  useAuiState,
} from "@assistant-ui/react";
import {
  ArchiveIcon,
  ArrowDownIcon,
  ArrowUpIcon,
  CheckIcon,
  ChevronDownIcon,
  CopyIcon,
  DownloadIcon,
  PencilIcon,
  RefreshCwIcon,
  SquareIcon,
} from "lucide-react";
import { useState, type FC } from "react";

const messageGroupBy = groupPartByType({
  "tool-call": ["group-investigation"],
});

export type ThreadProps = {
  autoFocus?: boolean | undefined;
};

// Startup exposes a loading placeholder thread; treat it as a new chat so
// the composer mounts centered. Loads after startup keep the docked layout.
const isNewChatView = (s: AssistantState) =>
  s.thread.messages.length === 0 &&
  (!s.thread.isLoading || s.threads.isLoading);

// A switched thread that is still fetching its history: skeleton, not welcome.
const isHistoryLoadingView = (s: AssistantState) =>
  s.thread.messages.length === 0 &&
  s.thread.isLoading &&
  !s.thread.isDisabled &&
  !s.threads.isLoading;

const ThreadHistorySkeleton: FC = () => (
  <div
    data-slot="aui_thread-history-skeleton"
    role="status"
    className="animate-in fade-in fill-mode-both flex flex-col gap-y-6 [animation-delay:150ms] [animation-duration:200ms]"
  >
    <span className="sr-only">正在载入会话</span>
    <Skeleton className="ml-auto h-9 w-2/5 rounded-xl motion-reduce:animate-none" />
    <div className="flex flex-col gap-y-2">
      <Skeleton className="h-4 w-11/12 motion-reduce:animate-none" />
      <Skeleton className="h-4 w-4/5 motion-reduce:animate-none" />
      <Skeleton className="h-4 w-3/5 motion-reduce:animate-none" />
    </div>
    <Skeleton className="ml-auto h-9 w-1/3 rounded-xl motion-reduce:animate-none" />
    <div className="flex flex-col gap-y-2">
      <Skeleton className="h-4 w-10/12 motion-reduce:animate-none" />
      <Skeleton className="h-4 w-2/3 motion-reduce:animate-none" />
    </div>
  </div>
);

export const Thread: FC<ThreadProps> = ({ autoFocus = true }) => {
  const isEmpty = useAuiState(isNewChatView);

  return (
    <ThreadPrimitive.Root
      className="aui-root aui-thread-root bg-background @container flex h-full min-h-0 min-w-0 flex-col font-sans"
      style={{
        ["--thread-max-width" as string]: "48rem",
        ["--composer-radius" as string]: "1.25rem",
      }}
    >
      <ThreadPrimitive.Viewport
        turnAnchor="top"
        data-slot="aui_thread-viewport"
        className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-x-auto overflow-y-auto [scrollbar-gutter:stable] [overflow-anchor:none]"
      >
        <div
          className={cn(
            "mx-auto flex w-full max-w-(--thread-max-width) flex-1 flex-col px-4 pt-4",
            isEmpty && "justify-center",
          )}
        >
          <AuiIf condition={isNewChatView}>
            <TodayAttention />
          </AuiIf>
          <AuiIf condition={isHistoryLoadingView}>
            <ThreadHistorySkeleton />
          </AuiIf>

          <div
            data-slot="aui_message-group"
            className="mb-14 flex flex-col gap-y-6 empty:hidden"
          >
            <ThreadPrimitive.Messages components={{ Message: ThreadMessage, EditComposer }} />
          </div>

          <ThreadPrimitive.ViewportFooter
            className={cn(
              "aui-thread-viewport-footer bg-background flex flex-col gap-4 overflow-visible px-2 pb-[max(1rem,env(safe-area-inset-bottom))] md:pb-6",
              "sticky bottom-0",
              // 内容滑入输入框下方时渐隐，而不是被硬切。
              !isEmpty &&
                "before:from-background before:pointer-events-none before:absolute before:inset-x-0 before:-top-6 before:h-6 before:bg-linear-to-t mt-auto",
            )}
          >
            <ThreadScrollToBottom />
            <Composer autoFocus={autoFocus} />
          </ThreadPrimitive.ViewportFooter>
        </div>
      </ThreadPrimitive.Viewport>
    </ThreadPrimitive.Root>
  );
};

const ThreadSummaryMessageView: FC<{ text: string }> = ({ text }) => {
  const [expanded, setExpanded] = useState(false);

  if (!text || !text.trim()) return null;

  return (
    <div
      data-slot="aui_summary-message-root"
      className="w-full max-w-(--thread-max-width) mx-auto px-2"
    >
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
        className="text-muted-foreground hover:text-foreground flex min-h-8 items-center gap-2 text-left text-sm transition-colors"
      >
        <ArchiveIcon className="size-3.5 shrink-0" />
        <span>更早的对话已压缩为摘要</span>
        <ChevronDownIcon
          className={cn(
            "size-3.5 shrink-0 transition-transform duration-200 motion-reduce:transition-none",
            expanded && "rotate-180",
          )}
        />
      </button>
      {expanded && (
        <p className="text-muted-foreground border-s ps-3 mt-1 text-sm leading-relaxed">{text}</p>
      )}
    </div>
  );
};

const AuiSummaryMessageText: FC = () => {
  const auiText = useAuiState((s) => {
    const parts = s.message?.content ?? [];
    return parts
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join("\n");
  });
  return <ThreadSummaryMessageView text={auiText} />;
};

export const ThreadSummaryMessage: FC<{ text?: string }> = ({
  text: propText,
}) => {
  if (propText !== undefined) {
    return <ThreadSummaryMessageView text={propText} />;
  }
  return <AuiSummaryMessageText />;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// 官方 converter 保持摘要 HumanMessage 的 user 角色，且不会把顶层 lc_source
// 提升到 assistant-ui custom metadata，因此按消息 ID 从公开 LangGraph state 复核。
export const hasSummarizationSource = (
  messages: readonly unknown[],
  messageId: string,
) =>
  messages.some((message) => {
    if (!isRecord(message) || message.id !== messageId) return false;
    const additionalKwargs = message.additional_kwargs;
    if (!isRecord(additionalKwargs)) return false;
    if (additionalKwargs.lc_source === "summarization") return true;
    return (
      isRecord(additionalKwargs.metadata) &&
      additionalKwargs.metadata.lc_source === "summarization"
    );
  });

const ThreadMessage: FC = () => {
  const role = useAuiState((s) => s.message.role);
  const hasSummaryMetadata = useAuiState((s) => {
    const custom = s.message.metadata.custom;
    return isRecord(custom) && custom.lc_source === "summarization";
  });

  if (role === "system" || hasSummaryMetadata) return <ThreadSummaryMessage />;
  if (role === "user") return <UserMessage />;
  return <AssistantMessage />;
};

const ThreadScrollToBottom: FC = () => {
  return (
    <ThreadPrimitive.ScrollToBottom asChild>
      <TooltipIconButton
        tooltip="回到最新消息"
        variant="outline"
        className="aui-thread-scroll-to-bottom bg-background hover:bg-accent absolute -top-12 z-10 size-8 self-center rounded-full p-0 shadow-sm disabled:invisible [&_svg]:size-4"
      >
        <ArrowDownIcon />
      </TooltipIconButton>
    </ThreadPrimitive.ScrollToBottom>
  );
};

const Composer: FC<{ autoFocus: boolean }> = ({ autoFocus }) => {
  const { composerInputRef } = useStationInspector();

  return (
    <ComposerPrimitive.Root
      data-slot="aui_composer-shell"
      className="aui-composer-root bg-card focus-within:border-ring relative flex w-full cursor-text items-end gap-2 rounded-(--composer-radius) border py-2 ps-4 pe-2 shadow-xs transition-[border-color]"
    >
      <ComposerPrimitive.Input
        ref={composerInputRef}
        placeholder="询问监测数据、变化趋势、降雨关联或场地环境…"
        className="aui-composer-input caret-primary placeholder:text-muted-foreground max-h-48 min-h-8 min-w-0 flex-1 resize-none bg-transparent py-1 text-base leading-6 outline-none"
        rows={1}
        autoFocus={autoFocus}
        enterKeyHint="send"
        aria-label="输入监测问题"
      />
      <ComposerAction />
    </ComposerPrimitive.Root>
  );
};

const ComposerContextUsage: FC = () => {
  const contextUsage = useSessionMetadata()?.context_usage;
  return <ContextUsageElement usage={contextUsage} />;
};

const ComposerAction: FC = () => {
  return (
    <div className="aui-composer-action-wrapper flex h-8 shrink-0 items-center gap-1.5">
      <ComposerContextUsage />
      <AuiIf condition={(s) => !s.thread.isRunning}>
        <ComposerPrimitive.Send asChild>
          <TooltipIconButton
            tooltip="发送消息"
            side="bottom"
            type="button"
            variant="default"
            size="icon"
            className="aui-composer-send size-8 rounded-full"
            aria-label="发送消息"
          >
            <ArrowUpIcon className="aui-composer-send-icon size-4" />
          </TooltipIconButton>
        </ComposerPrimitive.Send>
      </AuiIf>
      <AuiIf condition={(s) => s.thread.isRunning}>
        <ComposerPrimitive.Cancel asChild>
          <Button
            type="button"
            variant="default"
            size="icon"
            className="aui-composer-cancel size-8 rounded-full"
            aria-label="停止生成"
          >
            <SquareIcon className="aui-composer-cancel-icon size-3.5 fill-current" />
          </Button>
        </ComposerPrimitive.Cancel>
      </AuiIf>
    </div>
  );
};

const MessageError: FC = () => {
  return (
    <MessagePrimitive.Error>
      <ErrorPrimitive.Root className="aui-message-error-root border-destructive/40 bg-destructive/10 text-destructive mt-2 rounded-md border p-3 text-sm">
        <ErrorPrimitive.Message className="aui-message-error-message wrap-break-word" />
      </ErrorPrimitive.Root>
    </MessagePrimitive.Error>
  );
};

const AssistantMessage: FC = () => {
  return (
    <MessagePrimitive.Root
      data-slot="aui_assistant-message-root"
      data-role="assistant"
      className="fade-in slide-in-from-bottom-1 animate-in relative duration-150 [contain-intrinsic-size:auto_200px] [content-visibility:auto]"
    >
      <div
        data-slot="aui_assistant-message-content"
        className="text-foreground px-2 leading-relaxed wrap-break-word"
      >
        <MessagePrimitive.GroupedParts groupBy={messageGroupBy}>
          {({ part }) => {
            switch (part.type) {
              case "group-investigation":
                return <InvestigationProcess firstPartIndex={part.indices[0]!} />;
              case "text":
                return <MarkdownText />;
              case "tool-call":
                return <></>;
              case "indicator":
                return <InvestigationIndicator />;
              default:
                return null;
            }
          }}
        </MessagePrimitive.GroupedParts>
        <InvestigationReport />
        <MessageError />
      </div>

      {/* 预留固定工具栏高度，显示隐藏按钮时不改变消息布局。 */}
      <div
        data-slot="aui_assistant-message-footer"
        className="ms-2 flex h-10 shrink-0 items-center pt-1.5"
      >
        <AssistantActionBar />
      </div>
    </MessagePrimitive.Root>
  );
};

const AssistantActionBar: FC = () => {
  const hasReport = useAuiState((s) => findReport(s.message.parts) !== undefined);

  return (
    <ActionBarPrimitive.Root
      hideWhenRunning
      autohide="not-last"
      className="aui-assistant-action-bar-root text-muted-foreground animate-in fade-in -ms-1 flex gap-1 duration-200"
    >
      {hasReport ? (
        <ReportActions />
      ) : (
        <ActionBarPrimitive.Copy asChild>
          <TooltipIconButton tooltip="复制">
            <AuiIf condition={(s) => s.message.isCopied}>
              <CheckIcon className="animate-in zoom-in-50 fade-in duration-200 ease-out" />
            </AuiIf>
            <AuiIf condition={(s) => !s.message.isCopied}>
              <CopyIcon className="animate-in zoom-in-75 fade-in duration-150" />
            </AuiIf>
          </TooltipIconButton>
        </ActionBarPrimitive.Copy>
      )}
      <ActionBarPrimitive.Reload asChild>
        <TooltipIconButton tooltip="重新生成">
          <RefreshCwIcon />
        </TooltipIconButton>
      </ActionBarPrimitive.Reload>
      {!hasReport && (
        <ActionBarPrimitive.ExportMarkdown asChild>
          <TooltipIconButton tooltip="导出为 Markdown">
            <DownloadIcon />
          </TooltipIconButton>
        </ActionBarPrimitive.ExportMarkdown>
      )}
    </ActionBarPrimitive.Root>
  );
};

const UserMessage: FC = () => {
  return (
    <MessagePrimitive.Root
      data-slot="aui_user-message-root"
      className="fade-in slide-in-from-bottom-1 animate-in grid auto-rows-auto grid-cols-[minmax(72px,1fr)_auto] content-start gap-y-2 px-2 duration-150 [contain-intrinsic-size:auto_200px] [content-visibility:auto] [&:where(>*)]:col-start-2"
      data-role="user"
    >
      <div className="aui-user-message-content-wrapper relative col-start-2 min-w-0 pb-8">
        <div className="aui-user-message-content peer bg-muted text-foreground rounded-(--composer-radius) px-4 py-2 wrap-break-word empty:hidden">
          <MessagePrimitive.Parts />
        </div>
        <div className="aui-user-action-bar-wrapper absolute end-0 bottom-0 h-8 pt-1 peer-empty:hidden">
          <UserActionBar />
        </div>
      </div>
    </MessagePrimitive.Root>
  );
};

const UserActionBar: FC = () => {
  return (
    <ActionBarPrimitive.Root
      hideWhenRunning
      autohide="always"
      className="aui-user-action-bar-root flex items-center justify-end gap-1"
    >
      <ActionBarPrimitive.Copy asChild>
        <TooltipIconButton tooltip="复制消息">
          <AuiIf condition={(s) => s.message.isCopied}><CheckIcon /></AuiIf>
          <AuiIf condition={(s) => !s.message.isCopied}><CopyIcon /></AuiIf>
        </TooltipIconButton>
      </ActionBarPrimitive.Copy>
      <AuiIf condition={(s) => !s.thread.isRunning && !s.thread.messages.slice(s.message.index + 1).some((message) => message.role === "user")}>
        <ActionBarPrimitive.Edit asChild>
          <TooltipIconButton tooltip="编辑消息" className="aui-user-action-edit">
            <PencilIcon />
          </TooltipIconButton>
        </ActionBarPrimitive.Edit>
      </AuiIf>
    </ActionBarPrimitive.Root>
  );
};

const EditComposer: FC = () => {
  return (
    <MessagePrimitive.Root
      data-slot="aui_edit-composer-wrapper"
      className="flex flex-col px-2 [contain-intrinsic-size:auto_200px] [content-visibility:auto]"
    >
      <ComposerPrimitive.Root className="aui-edit-composer-root bg-card focus-within:border-ring ms-auto flex w-full max-w-[85%] cursor-text flex-col rounded-(--composer-radius) border transition-[border-color]">
        <ComposerPrimitive.Input
          aria-label="编辑用户消息"
          className="aui-edit-composer-input text-foreground min-h-14 w-full resize-none bg-transparent px-4 pt-3 pb-1 text-base outline-none"
          autoFocus
        />
        <div className="aui-edit-composer-footer mx-2.5 mb-2.5 flex items-center gap-1.5 self-end">
          <ComposerPrimitive.Cancel asChild>
            <Button variant="ghost" size="sm" className="h-8 px-3">
              取消
            </Button>
          </ComposerPrimitive.Cancel>
          <ComposerPrimitive.Send asChild>
            <Button size="sm" className="h-8 px-3">
              保存并重新生成
            </Button>
          </ComposerPrimitive.Send>
        </div>
      </ComposerPrimitive.Root>
    </MessagePrimitive.Root>
  );
};

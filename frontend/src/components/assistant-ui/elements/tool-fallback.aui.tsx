"use client";

import { memo, useCallback, useRef, useState } from "react";
import {
  AlertCircleIcon,
  CheckIcon,
  ChevronDownIcon,
  LoaderIcon,
  XCircleIcon,
} from "lucide-react";
import {
  toolApprovalAcceptsText,
  useAuiState,
  useScrollLock,
  useToolCallElapsed,
  type ToolApprovalOption,
  type ToolCallMessagePart,
  type ToolCallMessagePartProps,
  type ToolCallMessagePartStatus,
  type ToolCallMessagePartComponent,
} from "@assistant-ui/react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  useLangChainToolCalls,
} from "@assistant-ui/react-langchain";
import {
  getToolRegistryItem,
  decodeToolArtifact,
  FALLBACK_TOOL_LABELS,
} from "@/features/monitoring/tools/registry";
import {
  useLiveToolEvents,
  getLiveToolArtifact,
} from "@/lib/langgraph/live-tool-results";

const ANIMATION_DURATION = 200;

const pressable = "active:scale-[0.98]";

export type ToolFallbackRootProps = Omit<
  React.ComponentProps<typeof Collapsible>,
  "open" | "onOpenChange"
> & {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  defaultOpen?: boolean;
};

function ToolFallbackRoot({
  className,
  open: controlledOpen,
  onOpenChange: controlledOnOpenChange,
  defaultOpen = false,
  children,
  ...props
}: ToolFallbackRootProps) {
  const collapsibleRef = useRef<HTMLDivElement>(null);
  const lockScroll = useScrollLock(collapsibleRef, ANIMATION_DURATION);
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);

  const isControlled = controlledOpen !== undefined;
  const isOpen = isControlled ? controlledOpen : uncontrolledOpen;

  const handleOpenChange = useCallback(
    (open: boolean) => {
      lockScroll();
      if (!isControlled) {
        setUncontrolledOpen(open);
      }
      controlledOnOpenChange?.(open);
    },
    [lockScroll, isControlled, controlledOnOpenChange],
  );

  return (
    <Collapsible
      ref={collapsibleRef}
      data-slot="tool-fallback-root"
      open={isOpen}
      onOpenChange={handleOpenChange}
      className={cn(
        "aui-tool-fallback-root group/tool-fallback-root w-full",
        className,
      )}
      style={
        {
          "--animation-duration": `${ANIMATION_DURATION}ms`,
        } as React.CSSProperties
      }
      {...props}
    >
      {children}
    </Collapsible>
  );
}

type ToolStatus = ToolCallMessagePartStatus["type"];

const statusIconMap: Record<ToolStatus, React.ElementType> = {
  running: LoaderIcon,
  complete: CheckIcon,
  incomplete: XCircleIcon,
  "requires-action": AlertCircleIcon,
};

const formatToolDuration = (ms: number) => {
  if (ms < 1000) return "<1s";
  const seconds = ms / 1000;
  if (seconds < 10) return `${(Math.floor(seconds * 10) / 10).toFixed(1)}s`;
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  return `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`;
};

function ToolFallbackDuration({
  className,
  ...props
}: React.ComponentProps<"span">) {
  const elapsedMs = useToolCallElapsed();
  if (elapsedMs === undefined) return null;

  return (
    <span
      data-slot="tool-fallback-duration"
      className={cn(
        "aui-tool-fallback-duration text-muted-foreground/60 text-[11px] tabular-nums",
        className,
      )}
      {...props}
    >
      {formatToolDuration(elapsedMs)}
    </span>
  );
}

function ToolFallbackTrigger({
  toolName,
  status,
  className,
  ...props
}: React.ComponentProps<typeof CollapsibleTrigger> & {
  toolName: string;
  status?: ToolCallMessagePartStatus;
}) {
  const statusType = status?.type ?? "complete";
  const isRunning = statusType === "running";
  const isCancelled =
    status?.type === "incomplete" && status.reason === "cancelled";

  const Icon = statusIconMap[statusType];
  const item = getToolRegistryItem(toolName);

  let displayLabel: string;
  if (isRunning) {
    displayLabel = item?.runningLabel ?? FALLBACK_TOOL_LABELS.running;
  } else if (isCancelled) {
    displayLabel = item?.cancelledLabel ?? FALLBACK_TOOL_LABELS.cancelled;
  } else if (statusType === "requires-action") {
    displayLabel = item ? `待确认: ${item.label}` : FALLBACK_TOOL_LABELS.requiresAction;
  } else if (statusType === "incomplete") {
    displayLabel = item?.errorLabel ?? FALLBACK_TOOL_LABELS.error;
  } else {
    displayLabel = item?.completeLabel ?? FALLBACK_TOOL_LABELS.complete;
  }

  return (
    <CollapsibleTrigger
      data-slot="tool-fallback-trigger"
      className={cn(
        "aui-tool-fallback-trigger group/trigger text-muted-foreground hover:text-foreground flex w-fit min-h-7 origin-left items-center gap-1.5 py-1 text-xs transition-[color,scale] active:scale-[0.98]",
        className,
      )}
      disabled={isRunning}
      {...props}
    >
      <Icon
        data-slot="tool-fallback-trigger-icon"
        className={cn(
          "aui-tool-fallback-trigger-icon size-3.5 shrink-0",
          isCancelled && "text-muted-foreground",
          isRunning && "animate-spin [animation-duration:0.8s] text-muted-foreground",
          statusType === "complete" && "text-muted-foreground",
          statusType === "incomplete" && !isCancelled && "text-destructive/80",
          statusType === "requires-action" && "text-amber-500/90",
        )}
      />
      <span
        data-slot="tool-fallback-trigger-label"
        className={cn(
          "aui-tool-fallback-trigger-label-wrapper inline-block text-start leading-none font-normal text-foreground/85",
          isCancelled && "text-muted-foreground line-through",
          isRunning && "shimmer motion-reduce:animate-none",
        )}
      >
        {displayLabel}
      </span>
      <ToolFallbackDuration />
      {!isRunning && (
        <ChevronDownIcon
          data-slot="tool-fallback-trigger-chevron"
          className={cn(
            "aui-tool-fallback-trigger-chevron size-3 shrink-0 text-muted-foreground/50",
            "transition-transform duration-(--animation-duration) ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none",
            "-rotate-90",
            "group-data-open/trigger:rotate-0",
            "group-data-panel-open/trigger:rotate-0",
          )}
        />
      )}
    </CollapsibleTrigger>
  );
}

function ToolFallbackContent({
  className,
  children,
  ...props
}: React.ComponentProps<typeof CollapsibleContent>) {
  return (
    <CollapsibleContent
      data-slot="tool-fallback-content"
      className={cn(
        "aui-tool-fallback-content relative overflow-hidden text-sm outline-none",
        "group/collapsible-content ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:animate-none",
        "data-closed:animate-collapsible-up",
        "data-open:animate-collapsible-down",
        "data-closed:fill-mode-forwards",
        "data-closed:pointer-events-none",
        "[--tw-duration:var(--animation-duration)]",
        className,
      )}
      {...props}
    >
      <div
        className={cn(
          "flex flex-col gap-2 ps-5 my-1.5 border-s border-border/40 ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:animate-none",
          "group-data-open/collapsible-content:animate-in group-data-open/collapsible-content:fade-in-0 group-data-open/collapsible-content:blur-in-[2px] group-data-open/collapsible-content:slide-in-from-top-1",
          "group-data-closed/collapsible-content:animate-out group-data-closed/collapsible-content:fade-out-0 group-data-closed/collapsible-content:blur-out-[2px] group-data-closed/collapsible-content:slide-out-to-top-1",
          "group-data-closed/collapsible-content:animation-duration-(--animation-duration) group-data-open/collapsible-content:animation-duration-(--animation-duration)",
        )}
      >
        {children}
      </div>
    </CollapsibleContent>
  );
}

const APPROVED_RESULT = "用户已允许执行";
const DENIED_RESULT = "用户已拒绝执行";

const APPROVAL_OPTION_DEFAULT_LABELS: Record<string, string> = {
  "allow-once": "允许本次",
  "allow-always": "总是允许",
  "reject-once": "拒绝本次",
  "reject-always": "总是拒绝",
};

const isKnownKind = (kind: string) =>
  Object.hasOwn(APPROVAL_OPTION_DEFAULT_LABELS, kind);

const isAllowKind = (kind: string) =>
  kind === "allow-once" || kind === "allow-always";

const approvalOptionLabel = (option: ToolApprovalOption) =>
  option.label ??
  (isKnownKind(option.kind)
    ? APPROVAL_OPTION_DEFAULT_LABELS[option.kind]
    : undefined) ??
  option.id;

/**
 * A request that declares how it wants to be presented is asking a question,
 * not gating an action, so a refusal is not one of the answers it accepts.
 */
const isQuestion = (approval: ToolCallMessagePart["approval"]) =>
  approval?.display === "select" || approval?.display === "text";

const offersInterruptAction = (
  status: ToolCallMessagePartStatus | undefined,
  approval: ToolCallMessagePart["approval"],
  interrupt: ToolCallMessagePart["interrupt"],
) =>
  status?.type !== "requires-action" ||
  status.reason !== "interrupt" ||
  approval != null ||
  interrupt != null;

function ToolFallbackApproval({
  className,
  addResult,
  resume,
  interrupt,
  approval,
  respondToApproval,
  status,
  ...props
}: React.ComponentProps<"div"> &
  Partial<
    Pick<
      ToolCallMessagePartProps,
      "addResult" | "resume" | "respondToApproval" | "status"
    >
  > & {
    interrupt?: ToolCallMessagePart["interrupt"];
    approval?: ToolCallMessagePart["approval"];
  }) {
  const [submitted, setSubmitted] = useState(false);
  const voiceActive = useAuiState((s) => s.thread.voice !== undefined);
  const locked = submitted || voiceActive;
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [answer, setAnswer] = useState("");
  const [error, setError] = useState<string | null>(null);

  if (
    approval != null &&
    (approval.approved !== undefined || approval.resolution !== undefined)
  )
    return null;

  if (!offersInterruptAction(status, approval, interrupt)) return null;

  // A declared option list is a host constraint: the kit never adds an
  // approval path beyond it, and preserves a refusal path only where the
  // request is an action the user may refuse.
  const declaredOptions = respondToApproval ? approval?.options : undefined;
  const acceptsText =
    approval != null &&
    respondToApproval != null &&
    toolApprovalAcceptsText(approval);

  // A refused response leaves the request open, so the controls come back
  // rather than staying spent on a decision the runtime never recorded.
  const submit = (send: () => Promise<void> | void) => {
    setSubmitted(true);
    setError(null);
    void (async () => {
      try {
        await send();
      } catch (sendError) {
        setSubmitted(false);
        setError(
          sendError instanceof Error ? sendError.message : String(sendError),
        );
      }
    })();
  };

  const respond = (approved: boolean) => {
    if (locked) return;
    if (
      approval != null &&
      approval.approved === undefined &&
      respondToApproval
    ) {
      submit(() => respondToApproval({ approved, ...typedAnswer() }));
    } else if (interrupt) {
      submit(() => resume?.({ approved }));
    } else if (
      status?.type === "requires-action" &&
      status.reason === "interrupt"
    ) {
      return;
    } else {
      submit(() => addResult?.(approved ? APPROVED_RESULT : DENIED_RESULT));
    }
  };

  const respondWithOption = (option: ToolApprovalOption) => {
    if (locked) return;
    setConfirmingId(null);
    // A custom kind has no decision class for the runtime to derive, and
    // responding without one throws; picking a declared option is an answer,
    // so it resolves as approved.
    submit(() =>
      respondToApproval?.(
        isKnownKind(option.kind)
          ? { optionId: option.id, ...typedAnswer() }
          : { optionId: option.id, approved: true, ...typedAnswer() },
      ),
    );
  };

  const typedAnswer = () => (answer.trim() ? { text: answer } : {});

  const submitAnswer = () => {
    if (locked || !answer.trim()) return;
    submit(() => respondToApproval?.({ text: answer }));
  };

  const handleOption = (option: ToolApprovalOption) => {
    if (option.confirm) {
      setConfirmingId(option.id);
    } else {
      respondWithOption(option);
    }
  };

  const confirming =
    confirmingId != null
      ? declaredOptions?.find((o) => o.id === confirmingId)
      : undefined;

  const question = isQuestion(approval);

  const promptText = approval?.prompt ? (
    <p className="aui-tool-fallback-approval-prompt text-foreground">
      {approval.prompt}
    </p>
  ) : null;

  const errorText = error ? (
    <p
      role="alert"
      className="aui-tool-fallback-approval-error text-destructive text-xs"
    >
      {error}
    </p>
  ) : null;

  const answerField = acceptsText ? (
    <div className="aui-tool-fallback-approval-answer flex flex-col items-start gap-2">
      <Textarea
        value={answer}
        onChange={(event) => setAnswer(event.target.value)}
        disabled={locked}
        aria-label={question ? (approval?.prompt ?? "回复") : "备注"}
        placeholder={
          question ? "输入您的回复" : "为您的决策添加备注"
        }
      />
      {question && (
        <Button
          size="sm"
          className={pressable}
          onClick={submitAnswer}
          disabled={locked || !answer.trim()}
        >
          发送
        </Button>
      )}
    </div>
  ) : null;

  if (confirming) {
    const confirmMeta =
      typeof confirming.confirm === "object" ? confirming.confirm : undefined;
    const confirmDescription =
      confirmMeta?.description ?? confirming.description;
    return (
      <div
        data-slot="tool-fallback-approval-confirm"
        className={cn(
          "aui-tool-fallback-approval-confirm flex flex-col gap-2 pt-1",
          className,
        )}
        {...props}
      >
        <p className="aui-tool-fallback-approval-confirm-title font-semibold">
          {confirmMeta?.title ?? `${approvalOptionLabel(confirming)}?`}
        </p>
        {confirmDescription && (
          <p className="aui-tool-fallback-approval-confirm-description text-muted-foreground">
            {confirmDescription}
          </p>
        )}
        {confirming.grants && confirming.grants.length > 0 && (
          <ul className="aui-tool-fallback-approval-confirm-grants flex flex-col gap-1">
            {confirming.grants.map((grant) => (
              <li key={grant}>
                <code className="aui-tool-fallback-approval-confirm-grant bg-muted rounded px-1.5 py-0.5 text-xs">
                  {grant}
                </code>
              </li>
            ))}
          </ul>
        )}
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            className={pressable}
            onClick={() => respondWithOption(confirming)}
            disabled={locked}
          >
            确认
          </Button>
          <Button
            size="sm"
            variant="outline"
            className={pressable}
            onClick={() => setConfirmingId(null)}
            disabled={locked}
          >
            返回
          </Button>
        </div>
      </div>
    );
  }

  if (declaredOptions && declaredOptions.length > 0) {
    const allowOptions = declaredOptions.filter((o) => isAllowKind(o.kind));
    const customOptions = declaredOptions.filter((o) => !isKnownKind(o.kind));
    const rejectOptions = declaredOptions.filter(
      (o) => isKnownKind(o.kind) && !isAllowKind(o.kind),
    );
    return (
      <div
        data-slot="tool-fallback-approval"
        className={cn(
          "aui-tool-fallback-approval flex flex-col gap-2 pt-1",
          className,
        )}
        {...props}
      >
        {promptText}
        <div className="flex flex-wrap items-center gap-2">
          {[...allowOptions, ...customOptions, ...rejectOptions].map(
            (option) => (
              <Button
                key={option.id}
                size="sm"
                variant={option === allowOptions[0] ? "default" : "outline"}
                className={pressable}
                onClick={() => handleOption(option)}
                disabled={locked}
              >
                {approvalOptionLabel(option)}
              </Button>
            ),
          )}
          {rejectOptions.length === 0 && !question && (
            <Button
              size="sm"
              variant="outline"
              className={pressable}
              onClick={() => respond(false)}
              disabled={locked}
            >
              拒绝
            </Button>
          )}
        </div>
        {answerField}
        {errorText}
      </div>
    );
  }

  // A question carries no decision to fabricate, so it renders only what the
  // request declared, even when that leaves nothing to act on here.
  if (question) {
    return (
      <div
        data-slot="tool-fallback-approval"
        className={cn(
          "aui-tool-fallback-approval flex flex-col gap-2 pt-1",
          className,
        )}
        {...props}
      >
        {promptText}
        {answerField}
        {errorText}
      </div>
    );
  }

  return (
    <div
      data-slot="tool-fallback-approval"
      className={cn(
        "aui-tool-fallback-approval flex flex-col gap-2 pt-1",
        className,
      )}
      {...props}
    >
      {promptText}
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          className={pressable}
          onClick={() => respond(true)}
          disabled={locked}
        >
          允许
        </Button>
        <Button
          size="sm"
          variant="outline"
          className={pressable}
          onClick={() => respond(false)}
          disabled={locked}
        >
          拒绝
        </Button>
      </div>
      {answerField}
      {errorText}
    </div>
  );
}

function getEffectiveStatus(
  liveToolCall: any | undefined,
  part: { status: ToolCallMessagePartStatus },
): ToolCallMessagePartStatus {
  if (part.status.type === "requires-action") {
    return part.status;
  }
  const statusType = liveToolCall?.status?.type ?? liveToolCall?.status;
  if (statusType === "running") {
    return { type: "running" };
  }
  if (statusType === "finished") {
    return { type: "complete" };
  }
  if (statusType === "error") {
    return {
      type: "incomplete",
      reason: "error",
      error:
        liveToolCall.status?.error ??
        liveToolCall.error ??
        (part.status.type === "incomplete" ? part.status.error : undefined),
    };
  }
  return part.status;
}

const ToolFallbackImpl: ToolCallMessagePartComponent = (props) => {
  const {
    toolName,
    status,
    addResult,
    resume,
    interrupt,
    approval,
    respondToApproval,
    ...restProps
  } = props;
  const toolCallId = (props as any).toolCallId;

  // 1. 读取官方 live tool call，驱动独立实时的状态更新
  const toolCalls = useLangChainToolCalls();
  const liveToolCall = toolCalls.find(
    (c: any) => c && (c.id === toolCallId || c.callId === toolCallId),
  );
  const effectiveStatus = getEffectiveStatus(liveToolCall, { status });

  // 2. 两阶段 artifact：优先使用 ToolMessage 已落盘持久化的 artifact；
  // 运行流式阶段使用 tools channel 的 live artifact
  const toolEvents = useLiveToolEvents();
  const liveArtifact = toolCallId ? getLiveToolArtifact(toolEvents, toolCallId) : undefined;
  const persistedArtifact =
    effectiveStatus.type === "complete"
      ? (status as any).artifact ?? (restProps as any).artifact
      : undefined;
  const rawArtifact = persistedArtifact ?? liveArtifact;
  const envelope = decodeToolArtifact(toolName, rawArtifact);

  const isRequiresAction = effectiveStatus?.type === "requires-action";
  const shouldRenderApproval =
    isRequiresAction && offersInterruptAction(effectiveStatus, approval, interrupt);

  const registryItem = getToolRegistryItem(toolName);
  const defaultOpen = isRequiresAction;

  const [open, setOpen] = useState(defaultOpen);
  const [prevRequiresAction, setPrevRequiresAction] =
    useState(isRequiresAction);
  if (isRequiresAction !== prevRequiresAction) {
    setPrevRequiresAction(isRequiresAction);
    if (isRequiresAction) setOpen(true);
  }

  // 3. 四态严格互斥分支渲染
  const renderContent = () => {
    // 分支 1: requires-action -> 仅审批 UI
    if (effectiveStatus.type === "requires-action") {
      if (shouldRenderApproval) {
        return (
          <ToolFallbackApproval
            addResult={addResult}
            resume={resume}
            interrupt={interrupt}
            approval={approval}
            respondToApproval={respondToApproval}
            status={effectiveStatus}
          />
        );
      }
      return null;
    }

    // 分支 2: incomplete -> 仅错误信息
    if (effectiveStatus.type === "incomplete") {
      if ((effectiveStatus as any).reason === "cancelled") {
        return (
          <div className="text-xs text-muted-foreground py-1 font-normal">
            操作已取消
          </div>
        );
      }
      const statusError = effectiveStatus.error;
      const errorMessage =
        envelope?.error?.message ||
        (typeof statusError === "string"
          ? statusError
          : statusError instanceof Error
            ? statusError.message
            : null);
      return (
        <div className="text-xs text-destructive/90 py-1 font-medium">
          {errorMessage || (registryItem ? registryItem.errorLabel : "工具调用异常")}
        </div>
      );
    }

    // 分支 3: complete -> 业务组件 / 业务提示，支持 partial 等非 error 状态
    if (effectiveStatus.type === "complete") {
      const isBusinessSuccess =
        envelope && envelope.status !== "error" && envelope.data !== undefined;

      if (registryItem && isBusinessSuccess) {
        return (
          <div className="mt-1">
            <registryItem.render
              envelope={envelope}
              data={envelope.data}
              artifactImages={envelope.images}
              siteEnvironment={envelope.site_environment}
            />
          </div>
        );
      }

      return (
        <div className="text-xs text-muted-foreground/80 py-1 font-normal">
          {registryItem
            ? "未查询到符合条件的业务监测数据。"
            : "已完成辅助信息查询并同步至模型上下文。"}
        </div>
      );
    }

    // 分支 4: running -> 纯净无多余占位
    return null;
  };

  return (
    <ToolFallbackRoot open={open} onOpenChange={setOpen}>
      <ToolFallbackTrigger toolName={toolName} status={effectiveStatus} />
      <ToolFallbackContent>{renderContent()}</ToolFallbackContent>
    </ToolFallbackRoot>
  );
};

const ToolFallback = memo(
  ToolFallbackImpl,
) as unknown as ToolCallMessagePartComponent & {
  Root: typeof ToolFallbackRoot;
  Trigger: typeof ToolFallbackTrigger;
  Content: typeof ToolFallbackContent;
  Approval: typeof ToolFallbackApproval;
};

ToolFallback.displayName = "ToolFallback";
ToolFallback.Root = ToolFallbackRoot;
ToolFallback.Trigger = ToolFallbackTrigger;
ToolFallback.Content = ToolFallbackContent;
ToolFallback.Approval = ToolFallbackApproval;

export {
  offersInterruptAction,
  ToolFallback,
  ToolFallbackRoot,
  ToolFallbackTrigger,
  ToolFallbackContent,
  ToolFallbackApproval,
};

import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
} from 'react';

interface PanelResizeOptions {
  storageKey: string;
  defaultWidth: number;
  minWidth: number;
  maxWidth: number;
  side: 'left' | 'right';
  panelRef: RefObject<HTMLElement | null>;
  availableWidth: () => number;
}

interface DragState {
  pointerId: number;
  startX: number;
  startWidth: number;
  width: number;
  maxWidth: number;
  handle: HTMLElement;
  panel: HTMLElement;
}

/** 拖动只改 CSS 变量；React 状态和同步存储只在一次操作结束时更新。 */
export function usePanelResize({
  storageKey,
  defaultWidth,
  minWidth,
  maxWidth,
  side,
  panelRef,
  availableWidth,
}: PanelResizeOptions) {
  const [width, setWidth] = useState(() => {
    try {
      const stored = Number(localStorage.getItem(storageKey));
      if (Number.isFinite(stored) && stored >= minWidth && stored <= maxWidth) {
        return stored;
      }
    } catch {
      // 无存储权限时仍可调整当前页面的面板。
    }
    return Math.min(maxWidth, Math.max(minWidth, defaultWidth));
  });
  const dragRef = useRef<DragState | null>(null);
  const frameRef = useRef<number | null>(null);

  const constrain = (next: number, available = availableWidth()) => {
    const maximum = Math.min(maxWidth, available);
    return Math.round(Math.max(minWidth, Math.min(next, maximum)));
  };
  const saveWidth = (next: number) => {
    setWidth(next);
    try {
      localStorage.setItem(storageKey, String(next));
    } catch {
      // 宽度仍保留在当前页面中，不阻止继续操作。
    }
  };

  const cancelFrame = () => {
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
  };

  const finishDrag = (commit: boolean) => {
    const drag = dragRef.current;
    if (!drag) {
      return;
    }
    cancelFrame();
    const hasChanged = drag.width !== drag.startWidth;
    const next = commit && hasChanged ? drag.width : width;
    drag.panel.style.setProperty('--panel-width', `${next}px`);
    drag.handle.setAttribute('aria-valuenow', String(next));
    delete drag.panel.dataset.resizing;
    delete document.documentElement.dataset.panelResizing;
    dragRef.current = null;
    if (drag.handle.hasPointerCapture(drag.pointerId)) {
      drag.handle.releasePointerCapture(drag.pointerId);
    }
    if (commit && hasChanged) {
      saveWidth(next);
    }
  };

  useEffect(() => () => {
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current);
    }
    const drag = dragRef.current;
    if (drag) {
      delete drag.panel.dataset.resizing;
      delete document.documentElement.dataset.panelResizing;
    }
  }, []);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    const panel = panelRef.current;
    if (!panel || event.button !== 0 || !event.isPrimary) {
      return;
    }
    event.preventDefault();
    event.currentTarget.focus();
    event.currentTarget.setPointerCapture(event.pointerId);
    panel.dataset.resizing = '';
    document.documentElement.dataset.panelResizing = '';
    const startWidth = panel.getBoundingClientRect().width;
    const maximum = constrain(maxWidth);
    event.currentTarget.setAttribute('aria-valuemax', String(maximum));
    // 边界在按下时测量一次，移动事件中不读取布局。
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth,
      width: startWidth,
      maxWidth: maximum,
      handle: event.currentTarget,
      panel,
    };
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || event.pointerId !== drag.pointerId) {
      return;
    }
    const direction = side === 'left' ? 1 : -1;
    drag.width = constrain(drag.startWidth + (event.clientX - drag.startX) * direction, drag.maxWidth);
    if (frameRef.current === null) {
      frameRef.current = requestAnimationFrame(() => {
        frameRef.current = null;
        drag.panel.style.setProperty('--panel-width', `${drag.width}px`);
        drag.handle.setAttribute('aria-valuenow', String(drag.width));
      });
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape' && dragRef.current) {
      event.preventDefault();
      event.stopPropagation();
      finishDrag(false);
      return;
    }
    if (dragRef.current || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      return;
    }
    event.preventDefault();
    const currentWidth = panelRef.current?.getBoundingClientRect().width ?? width;
    const direction = side === 'left' ? 1 : -1;
    let next = currentWidth;
    if (event.key === 'Home') {
      next = minWidth;
    } else if (event.key === 'End') {
      next = Math.min(maxWidth, availableWidth());
    } else {
      next += (event.key === 'ArrowRight' ? 1 : -1) * direction * (event.shiftKey ? 40 : 10);
    }
    saveWidth(constrain(next));
  };

  return {
    style: { '--panel-width': `${width}px` } as CSSProperties,
    onEscapeKeyDown: (event: globalThis.KeyboardEvent) => {
      // Radix 在 document 捕获阶段处理 Esc，需先撤销拖动，避免把抽屉一并关闭。
      if (dragRef.current) {
        event.preventDefault();
        finishDrag(false);
      }
    },
    handleProps: {
      'aria-valuemin': minWidth,
      'aria-valuemax': maxWidth,
      'aria-valuenow': width,
      onPointerDown,
      onPointerMove,
      onPointerUp: () => finishDrag(true),
      onPointerCancel: () => finishDrag(false),
      onLostPointerCapture: () => finishDrag(true),
      onKeyDown,
      onDoubleClick: () => saveWidth(constrain(defaultWidth)),
    },
  };
}

type PanelResizeHandleProps = ReturnType<typeof usePanelResize>['handleProps'] & {
  label: string;
  panelId: string;
  edge: 'left' | 'right';
};

export function PanelResizeHandle({ label, panelId, edge, ...props }: PanelResizeHandleProps) {
  return (
    <div
      role="separator"
      aria-label={label}
      aria-orientation="vertical"
      aria-controls={panelId}
      tabIndex={0}
      title="拖动调整宽度；方向键微调，双击恢复默认"
      className="panel-resize-handle"
      data-edge={edge}
      {...props}
    />
  );
}

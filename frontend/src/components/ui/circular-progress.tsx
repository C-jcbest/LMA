import * as React from "react";
import { Progress as ProgressPrimitive } from "radix-ui";
import { cn } from "@/lib/utils";

export interface CircularProgressProps
  extends React.ComponentPropsWithoutRef<typeof ProgressPrimitive.Root> {
  value?: number;
  size?: number;
  strokeWidth?: number;
  indicatorClassName?: string;
  trackClassName?: string;
}

export const CircularProgress = React.forwardRef<
  React.ElementRef<typeof ProgressPrimitive.Root>,
  CircularProgressProps
>(({
  className,
  value = 0,
  size = 20,
  strokeWidth = 2.5,
  indicatorClassName,
  trackClassName,
  children,
  ...props
}, ref) => {
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const clampedValue = Math.min(100, Math.max(0, value));
  const strokeDashoffset = circumference - (clampedValue / 100) * circumference;

  return (
    <ProgressPrimitive.Root
      ref={ref}
      data-slot="circular-progress"
      value={clampedValue}
      max={100}
      className={cn("relative inline-flex items-center justify-center shrink-0", className)}
      style={{ width: size, height: size }}
      {...props}
    >
      <svg
        className="size-full -rotate-90 overflow-visible"
        viewBox={`0 0 ${size} ${size}`}
        aria-hidden="true"
      >
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          strokeWidth={strokeWidth}
          fill="none"
          className={cn("stroke-neutral-200/80 dark:stroke-neutral-800", trackClassName)}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          strokeWidth={strokeWidth}
          fill="none"
          strokeDasharray={circumference}
          strokeDashoffset={strokeDashoffset}
          strokeLinecap="round"
          className={cn(
            "stroke-primary transition-all duration-500 ease-out",
            indicatorClassName
          )}
        />
      </svg>
      {children}
    </ProgressPrimitive.Root>
  );
});

CircularProgress.displayName = "CircularProgress";

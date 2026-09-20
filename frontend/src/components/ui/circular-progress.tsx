import * as React from "react";
import { cn } from "@/lib/utils";

export interface CircularProgressProps
  extends React.ComponentPropsWithoutRef<"svg"> {
  value?: number;
  size?: number;
  strokeWidth?: number;
  indicatorClassName?: string;
  trackClassName?: string;
}

export const CircularProgress = React.forwardRef<
  SVGSVGElement,
  CircularProgressProps
>(
  (
    {
      className,
      value = 0,
      size = 16,
      strokeWidth = 1.75,
      indicatorClassName,
      trackClassName,
      ...props
    },
    ref
  ) => {
    const radius = (size - strokeWidth) / 2;
    const circumference = 2 * Math.PI * radius;
    const clampedValue = Math.min(100, Math.max(0, value));
    const strokeDashoffset =
      circumference - (clampedValue / 100) * circumference;

    return (
      <svg
        ref={ref}
        role="progressbar"
        aria-valuenow={clampedValue}
        aria-valuemin={0}
        aria-valuemax={100}
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        className={cn("-rotate-90 overflow-visible", className)}
        {...props}
      >
        {/* 底轨环 */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          strokeWidth={strokeWidth}
          fill="none"
          className={cn(
            "stroke-foreground/15 dark:stroke-foreground/20",
            trackClassName
          )}
        />
        {/* 动态进度环 */}
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
            "stroke-foreground transition-all duration-300 ease-out",
            indicatorClassName
          )}
        />
      </svg>
    );
  }
);

CircularProgress.displayName = "CircularProgress";

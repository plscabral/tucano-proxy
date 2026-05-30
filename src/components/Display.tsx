import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Display heading in the new Tucano identity: a heavy Hanken Grotesk
 * grotesque with one or more "accent words" rendered in Newsreader italic
 * (see the brand reference — "Tecnologia que ajuda pessoas a *crescerem*").
 *
 * Use it for display surfaces only — wordmark, onboarding, empty states,
 * section heroes — never for tabular/data text (that stays IBM Plex Mono).
 *
 * Wrap accent words with <Accent>:
 *   <Display>Tucano <Accent>Proxy</Accent></Display>
 */
export function Display({
  as: Tag = "h1",
  className,
  children,
  ...rest
}: {
  as?: React.ElementType;
  className?: string;
  children: React.ReactNode;
} & React.HTMLAttributes<HTMLElement>) {
  return (
    <Tag
      className={cn(
        "font-sans font-extrabold tracking-tight leading-[1.05]",
        className,
      )}
      {...rest}
    >
      {children}
    </Tag>
  );
}

/** Editorial accent word — Newsreader italic, slightly lighter weight so it
 * reads as a graceful counterpoint to the surrounding grotesque. */
export function Accent({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <span className={cn("font-accent font-normal tracking-normal", className)}>
      {children}
    </span>
  );
}

import { ChevronRight } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

export type Crumb = { label: string; href?: string };

/** Breadcrumbs on the left, the page's actions on the right (Frame.io's header). */
export function TopBar({ crumbs, actions }: { crumbs: Crumb[]; actions?: ReactNode }) {
  return (
    <header className="flex h-14 shrink-0 items-center justify-between gap-4 border-b border-line bg-bg/85 px-4 backdrop-blur-md sm:px-6">
      <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5 text-[14px]">
        {crumbs.map((crumb, i) => {
          const last = i === crumbs.length - 1;
          return (
            <span key={`${crumb.label}-${i}`} className="flex min-w-0 items-center gap-1.5">
              {i > 0 && <ChevronRight className="size-3.5 shrink-0 text-faint" aria-hidden />}
              {crumb.href && !last ? (
                <Link href={crumb.href} className="truncate text-muted hover:text-text">
                  {crumb.label}
                </Link>
              ) : (
                <span className={`truncate ${last ? "font-medium text-text" : "text-muted"}`}>{crumb.label}</span>
              )}
            </span>
          );
        })}
      </nav>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </header>
  );
}

/** The quiet line along the bottom: item counts, sizes, background work. */
export function StatusBar({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <footer className="flex h-9 shrink-0 items-center justify-between gap-4 border-t border-line px-4 text-[12.5px] text-faint sm:px-6">
      <div className="min-w-0 truncate">{children}</div>
      {right && <div className="flex shrink-0 items-center gap-3">{right}</div>}
    </footer>
  );
}

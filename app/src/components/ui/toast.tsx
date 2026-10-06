"use client";

import { CircleAlert, CircleCheck, Info, X } from "lucide-react";
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

type Toast = {
  id: number;
  tone: "good" | "bad" | "info";
  title: string;
  detail?: string;
  action?: { label: string; onClick: () => void };
};

type ToastInput = Omit<Toast, "id">;

const ToastContext = createContext<(toast: ToastInput) => void>(() => {});

export function useToast() {
  return useContext(ToastContext);
}

const icons = {
  good: <CircleCheck className="size-5 shrink-0 text-good" aria-hidden />,
  bad: <CircleAlert className="size-5 shrink-0 text-bad" aria-hidden />,
  info: <Info className="size-5 shrink-0 text-info" aria-hidden />,
};

let nextId = 1;

/** Brief top-center messages, Frame.io style. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const dismiss = useCallback((id: number) => setToasts((all) => all.filter((t) => t.id !== id)), []);
  const show = useCallback(
    (toast: ToastInput) => {
      const id = nextId++;
      setToasts((all) => [...all.slice(-3), { ...toast, id }]);
      setTimeout(() => dismiss(id), toast.tone === "bad" ? 9000 : 5500);
    },
    [dismiss],
  );
  const value = useMemo(() => show, [show]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 top-3 z-[60] flex flex-col items-center gap-2 px-4" aria-live="polite">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className="pointer-events-auto flex w-full max-w-md animate-toast items-center gap-3 rounded-xl border border-line-strong bg-surface-2/95 px-4 py-3 shadow-lift backdrop-blur-md"
          >
            {icons[toast.tone]}
            <div className="min-w-0 flex-1">
              <p className="text-[13.5px] font-medium">{toast.title}</p>
              {toast.detail && <p className="mt-0.5 text-[12.5px] text-muted">{toast.detail}</p>}
            </div>
            {toast.action && (
              <button
                type="button"
                onClick={() => {
                  toast.action!.onClick();
                  dismiss(toast.id);
                }}
                className="shrink-0 rounded-md bg-surface-3 px-2.5 py-1 text-[12.5px] font-medium hover:bg-line-strong"
              >
                {toast.action.label}
              </button>
            )}
            <button
              type="button"
              aria-label="Dismiss"
              onClick={() => dismiss(toast.id)}
              className="grid size-6 shrink-0 place-items-center rounded-md text-faint hover:bg-surface-3 hover:text-text"
            >
              <X className="size-3.5" />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

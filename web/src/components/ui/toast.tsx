import { Toast as ToastPrimitive } from "radix-ui";
import * as React from "react";
import { cn } from "@/lib/utils";

type Item = { id: number; title: string; body?: string; tone: "default" | "danger" };
type Push = (title: string, opts?: { body?: string; tone?: Item["tone"] }) => void;

const ToastContext = React.createContext<Push>(() => {});
export const useToast = () => React.useContext(ToastContext);

/** Short confirmations ("Run started", "Copied") and errors, bottom right. */
export function Toaster({ children }: { children: React.ReactNode }) {
  const [items, setItems] = React.useState<Item[]>([]);
  const push = React.useCallback<Push>((title, opts) => {
    setItems((list) => [...list.slice(-2), { id: Date.now() + Math.random(), title, body: opts?.body, tone: opts?.tone ?? "default" }]);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      <ToastPrimitive.Provider duration={4500}>
        {children}
        {items.map((t) => (
          <ToastPrimitive.Root
            key={t.id}
            onOpenChange={(open) => !open && setItems((list) => list.filter((x) => x.id !== t.id))}
            className={cn(
              "grid gap-0.5 bg-primary px-4 py-3 text-primary-foreground shadow-pop animate-slide-in data-[state=closed]:animate-fade",
              t.tone === "danger" && "bg-[#AC0EB2] text-white",
            )}
          >
            <ToastPrimitive.Title className="font-mono text-[12px] uppercase tracking-[0.06em]">{t.title}</ToastPrimitive.Title>
            {t.body && <ToastPrimitive.Description className="text-[13px] opacity-85">{t.body}</ToastPrimitive.Description>}
          </ToastPrimitive.Root>
        ))}
        <ToastPrimitive.Viewport className="fixed right-4 bottom-4 z-[60] flex w-[min(380px,calc(100vw-32px))] flex-col gap-2 outline-none" />
      </ToastPrimitive.Provider>
    </ToastContext.Provider>
  );
}

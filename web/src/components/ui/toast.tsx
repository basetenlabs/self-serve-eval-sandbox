import { Toast as ToastPrimitive } from "radix-ui";
import * as React from "react";
import { cn } from "@/lib/utils";

type Item = { id: number; title: string; body?: string; tone: "default" | "danger" };
type Push = (title: string, opts?: { body?: string; tone?: Item["tone"] }) => void;

const ToastContext = React.createContext<Push>(() => {});
export const useToast = () => React.useContext(ToastContext);

/** Short confirmations ("Run started") and errors, bottom right: a flat Black block, Light Pink for a problem. */
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
            className={cn("ev-toast", t.tone === "danger" && "danger")}
          >
            <ToastPrimitive.Title className="title">{t.title}</ToastPrimitive.Title>
            {t.body && <ToastPrimitive.Description className="body">{t.body}</ToastPrimitive.Description>}
          </ToastPrimitive.Root>
        ))}
        <ToastPrimitive.Viewport className="ev-toasts" />
      </ToastPrimitive.Provider>
    </ToastContext.Provider>
  );
}

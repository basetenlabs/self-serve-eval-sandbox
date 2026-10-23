import { Toaster } from "@/components/ui/toast";
import { TooltipProvider } from "@/components/ui/tooltip";
import { HomePage } from "@/features/home/HomePage";
import { RunPage } from "@/features/run/RunPage";
import { useAppState } from "@/lib/api";
import { useRoute } from "@/lib/hooks";
import { Shell } from "./Shell";

export function App() {
  const [route, go] = useRoute();
  const { state, error, hurry } = useAppState(route.page === "run" ? route.id : undefined);
  return (
    <TooltipProvider>
      <Toaster>
        <Shell state={state} route={route} go={go} offline={!!error && !state}>
          {route.page === "run"
            ? <RunPage key={route.id} id={route.id} tab={route.tab} task={route.task} state={state} go={go} hurry={hurry} />
            : <HomePage state={state} error={error} go={go} hurry={hurry} />}
        </Shell>
      </Toaster>
    </TooltipProvider>
  );
}

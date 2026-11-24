import * as React from "react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AccessPage } from "@/features/access/AccessPage";
import { HomePage } from "@/features/home/HomePage";
import { RunPage } from "@/features/run/RunPage";
import { useAppState } from "@/lib/api";
import { useRoute } from "@/lib/hooks";
import { Shell } from "./Shell";

export function App() {
  const [route, go] = useRoute();
  const { state, error, hurry } = useAppState(route.page === "run" ? route.id : undefined);
  const [canRequest, setCanRequest] = React.useState<boolean | null>(null);
  React.useEffect(() => {
    fetch("/api/access-requests", { method: "HEAD", cache: "no-store" })
      .then(res => setCanRequest(res.status === 204)).catch(() => setCanRequest(false));
  }, []);
  return (
    <TooltipProvider>
        <Shell canRequest={!!canRequest} state={state} route={route} go={go} offline={!!error && !state}>
          {route.page === "run"
            ? <RunPage key={route.id} id={route.id} tab={route.tab} task={route.task} state={state} go={go} hurry={hurry} />
            : route.page === "access" ? <AccessPage admin={!!state?.admin} canRequest={canRequest} key={route.invite ?? ""} invite={route.invite} />
              : <HomePage state={state} error={error} go={go} hurry={hurry} />}
        </Shell>
    </TooltipProvider>
  );
}

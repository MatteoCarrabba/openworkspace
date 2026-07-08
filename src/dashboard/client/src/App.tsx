import React, { useEffect } from "react";
import { useStore } from "./store";
import { Header } from "./components/Header";
import { Rail } from "./components/Rail";
import { ProjectList } from "./components/ProjectList";
import { DetailPane } from "./components/DetailPane";
import { AutomationsView } from "./components/AutomationsView";

export function App(): React.JSX.Element {
  const { scan, scanError, view, refresh, ensureAutos } = useStore();

  // Initial load, mirroring the vanilla dashboard's `load()` call at the
  // bottom of the script. If the URL already asks for the automations view
  // (a deep link / reload), fetch that too.
  useEffect(() => {
    void (async () => {
      await refresh();
      if (view.view === "automations") await ensureAutos();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (scanError) {
    return <div className="empty">Scan failed: {scanError}</div>;
  }
  if (!scan) {
    return <div className="empty">Loading…</div>;
  }

  const projectsView = view.view === "projects";
  return (
    <>
      <Header />
      <div id="layout" style={{ display: projectsView ? "" : "none" }}>
        <Rail />
        <ProjectList />
        <DetailPane />
      </div>
      <div id="autos" style={{ display: projectsView ? "none" : "" }}>
        <AutomationsView />
      </div>
    </>
  );
}

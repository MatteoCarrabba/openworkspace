import React, { useEffect, useState } from "react";
import { useStore } from "./store";
import { Header } from "./components/Header";
import { Rail } from "./components/Rail";
import { ProjectList } from "./components/ProjectList";
import { DetailPane } from "./components/DetailPane";
import { AutomationsView } from "./components/AutomationsView";
import { Divider } from "./components/Divider";

// Mirrors the @media (max-width: 980px) breakpoint in global.css where
// #layout collapses to a single column — resizing (and its dividers) only
// makes sense above that width.
const MOBILE_QUERY = "(max-width: 980px)";

function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(() => window.matchMedia(MOBILE_QUERY).matches);
  useEffect(() => {
    const mql = window.matchMedia(MOBILE_QUERY);
    const onChange = (): void => setIsMobile(mql.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);
  return isMobile;
}

export function App(): React.JSX.Element {
  const { scan, scanError, view, refresh, ensureAutos, paneWidths } = useStore();
  const isMobile = useIsMobile();

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
  // Below the mobile breakpoint, leave grid-template-columns to the
  // stylesheet's media-query collapse (1 column) rather than fighting it
  // with an inline override.
  const layoutStyle: React.CSSProperties = {
    display: projectsView ? "" : "none",
    ...(isMobile ? {} : { gridTemplateColumns: `${paneWidths.rail}px 6px minmax(0, 1fr) 6px ${paneWidths.detail}px` }),
  };
  return (
    <>
      <Header />
      <div id="layout" style={layoutStyle}>
        <Rail />
        {isMobile ? null : <Divider pane="rail" />}
        <ProjectList />
        {isMobile ? null : <Divider pane="detail" />}
        <DetailPane />
      </div>
      <div id="autos" style={{ display: projectsView ? "none" : "" }}>
        <AutomationsView />
      </div>
    </>
  );
}

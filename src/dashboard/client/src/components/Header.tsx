import React from "react";
import { useStore } from "../store";

export function Header(): React.JSX.Element {
  const { scan, autos, view, setView, refresh, ensureAutos } = useStore();

  const onTab = (v: "projects" | "automations") => async (): Promise<void> => {
    if (v === "automations") await ensureAutos();
    setView({ view: v });
  };

  const onRefresh = async (): Promise<void> => {
    await refresh();
    if (view.view === "automations") await ensureAutos();
  };

  let scanTime = "";
  let chips: React.ReactNode = null;
  if (view.view === "automations") {
    if (autos) {
      scanTime = "scanned " + new Date(autos.generatedAt).toLocaleString();
      const n = autos.drift.length;
      chips = n ? <span className="chip waiting">{n} placement drift</span> : null;
    }
  } else if (scan) {
    scanTime = "scanned " + new Date(scan.generatedAt).toLocaleString();
    const a = scan.attention;
    chips = (
      <>
        {a.waiting ? <span className="chip waiting">{a.waiting} waiting</span> : null}
        {a.review ? <span className="chip review">{a.review} in review</span> : null}
        {a.unhiddenToday ? <span className="chip unhidden">{a.unhiddenToday} unhidden today</span> : null}
        {a.doctorErrors ? <span className="chip doctor">{a.doctorErrors} doctor errors</span> : null}
      </>
    );
  }

  return (
    <header>
      <h1 id="ws-name">{scan?.workspace.name ?? "OpenWorkspace"}</h1>
      <div className="viewtabs" id="viewtabs">
        <button className={view.view === "projects" ? "sel" : ""} onClick={onTab("projects")}>
          Projects
        </button>
        <button className={view.view === "automations" ? "sel" : ""} onClick={onTab("automations")}>
          Automations
        </button>
      </div>
      <span id="scan-time">{scanTime}</span>
      <div className="chips" id="attention">
        {chips}
      </div>
      <button id="refresh" title="Re-scan the live tree" onClick={() => void onRefresh()}>
        Refresh
      </button>
    </header>
  );
}

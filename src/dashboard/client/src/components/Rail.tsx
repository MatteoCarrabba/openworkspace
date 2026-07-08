import React from "react";
import { useStore } from "../store";
import type { ViewState } from "../types";

const STATUS_OPTIONS: Array<[ViewState["status"], string]> = [
  ["open", "Open"],
  ["all", "All"],
  ["todo", "Todo"],
  ["doing", "Doing"],
  ["waiting", "Waiting"],
  ["review", "Review"],
  ["done", "Done"],
];

export function Rail(): React.JSX.Element | null {
  const { scan, view, setView } = useStore();
  if (!scan) return null;
  const c = scan.counts;
  const scopes: Array<[ViewState["scope"], string, number]> = [
    ["active", "Active", c.active],
    ["all", "All", c.all],
    ["dormant", "Dormant", c.dormant],
    ["archived", "Archived", c.archived],
  ];

  return (
    <nav id="rail">
      {scopes.map(([key, label, n]) => (
        <button
          key={key}
          className={"scope" + (view.scope === key ? " sel" : "")}
          onClick={() => setView({ scope: key })}
        >
          {label} <span className="n">{n}</span>
        </button>
      ))}
      <div className="filter">
        <label htmlFor="task-search">Search</label>
        <input
          type="search"
          id="task-search"
          value={view.q}
          onChange={(e) => setView({ q: e.target.value })}
        />
      </div>
      <div className="filter">
        <label htmlFor="status-filter">Status</label>
        <select id="status-filter" value={view.status} onChange={(e) => setView({ status: e.target.value as ViewState["status"] })}>
          {STATUS_OPTIONS.map(([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </select>
      </div>
      <div className="toggle-row">
        <label>
          <input
            type="checkbox"
            id="subtasks-toggle"
            checked={view.subtasks}
            onChange={(e) => setView({ subtasks: e.target.checked })}
          />{" "}
          Subtasks shown
        </label>
      </div>
    </nav>
  );
}

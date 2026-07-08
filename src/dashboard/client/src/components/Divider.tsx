import React, { useCallback, useRef } from "react";
import { useStore } from "../store";
import type { PaneName } from "../store";

/**
 * Draggable grid-column divider sitting between rail|list or list|detail.
 * Desktop-only (see App.tsx, which doesn't render these below the mobile
 * breakpoint where #layout collapses to one column). Drags update the
 * store's persisted pane width; clamping happens in setPaneWidth.
 */
export function Divider({ pane }: { pane: PaneName }): React.JSX.Element {
  const { paneWidths, setPaneWidth } = useStore();
  const dragState = useRef<{ startX: number; startWidth: number } | null>(null);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      dragState.current = { startX: e.clientX, startWidth: paneWidths[pane] };
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    [pane, paneWidths],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragState.current;
      if (!drag) return;
      const delta = e.clientX - drag.startX;
      // The rail widens as the divider moves right; the detail pane widens
      // as its divider moves left — each divider only ever touches one width.
      const next = pane === "rail" ? drag.startWidth + delta : drag.startWidth - delta;
      setPaneWidth(pane, next);
    },
    [pane, setPaneWidth],
  );

  const onPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    dragState.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
  }, []);

  return (
    <div
      className="divider"
      role="separator"
      aria-orientation="vertical"
      aria-label={pane === "rail" ? "Resize project list" : "Resize task detail"}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    />
  );
}

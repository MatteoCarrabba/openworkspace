import React, { useState } from "react";

function shq(s: string): string {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

/** Copyable CLI command rows, ported from the vanilla dashboard's `.cli` section. */
export function CliCommands({ taskId, relPath }: { taskId: string; relPath: string }): React.JSX.Element {
  const ref = shq(relPath);
  const commands = [
    "projects task show " + taskId + " --project " + ref,
    "projects task edit " + taskId + " --project " + ref,
    "projects task status " + taskId + " done --project " + ref,
    "projects task hide " + taskId + " --until <date> --project " + ref,
  ];
  return (
    <div className="cli">
      <h4>CLI</h4>
      {commands.map((c) => (
        <CliRow key={c} cmd={c} />
      ))}
    </div>
  );
}

function CliRow({ cmd }: { cmd: string }): React.JSX.Element {
  const [copied, setCopied] = useState(false);
  return (
    <div className="cli-row">
      <code>{cmd}</code>
      <button
        onClick={() => {
          void navigator.clipboard.writeText(cmd).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          });
        }}
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

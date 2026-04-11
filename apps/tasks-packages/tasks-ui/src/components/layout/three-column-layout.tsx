import React from "react";

interface ThreeColumnLayoutProps {
  chatPanel: React.ReactNode;
  taskListPanel: React.ReactNode;
  taskDetailPanel: React.ReactNode;
}

export function ThreeColumnLayout({
  chatPanel,
  taskListPanel,
  taskDetailPanel,
}: ThreeColumnLayoutProps) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "320px 360px 1fr",
        height: "100%",
        width: "100%",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          borderRight: "1px solid #e2e8f0",
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
        }}
      >
        {chatPanel}
      </div>
      <div
        style={{
          borderRight: "1px solid #e2e8f0",
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
        }}
      >
        {taskListPanel}
      </div>
      <div
        style={{
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
        }}
      >
        {taskDetailPanel}
      </div>
    </div>
  );
}

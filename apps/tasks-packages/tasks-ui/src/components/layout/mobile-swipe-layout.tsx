import React from "react";

interface MobileSwipeLayoutProps {
  chatPanel: React.ReactNode;
  taskListPanel: React.ReactNode;
  taskDetailPanel: React.ReactNode;
}

export function MobileSwipeLayout({
  chatPanel,
  taskListPanel,
  taskDetailPanel,
}: MobileSwipeLayoutProps) {
  return (
    <div
      style={{
        display: "flex",
        overflowX: "auto",
        scrollSnapType: "x mandatory",
        WebkitOverflowScrolling: "touch",
        height: "100%",
        width: "100%",
      }}
    >
      <div
        style={{
          flex: "0 0 100%",
          scrollSnapAlign: "start",
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
        }}
      >
        {chatPanel}
      </div>
      <div
        style={{
          flex: "0 0 100%",
          scrollSnapAlign: "start",
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
        }}
      >
        {taskListPanel}
      </div>
      <div
        style={{
          flex: "0 0 100%",
          scrollSnapAlign: "start",
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

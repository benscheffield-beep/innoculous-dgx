import React, { createContext, useContext, useEffect, useState } from "react";

type Mode = "user" | "developer";

interface ModeContextType {
  mode: Mode;
  setMode: (mode: Mode) => void;
}

const ModeContext = createContext<ModeContextType | undefined>(undefined);

export function ModeProvider({ children }: { children: React.ReactNode }) {
  const [mode, setMode] = useState<Mode>(() => {
    const saved = localStorage.getItem("innoculus-mode");
    return (saved === "user" || saved === "developer") ? saved : "user";
  });

  useEffect(() => {
    localStorage.setItem("innoculus-mode", mode);
  }, [mode]);

  return (
    <ModeContext.Provider value={{ mode, setMode }}>
      {children}
    </ModeContext.Provider>
  );
}

export function useMode() {
  const ctx = useContext(ModeContext);
  if (!ctx) throw new Error("useMode must be used within a ModeProvider");
  return ctx;
}

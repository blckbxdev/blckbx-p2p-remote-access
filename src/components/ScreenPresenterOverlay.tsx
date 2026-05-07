import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";
import { SpinningCube } from "./SpinningCube";

export function ScreenPresenterOverlay() {
  const [connecting, setConnecting] = useState(false);

  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    void listen<{ connecting?: boolean }>("bx/presenter-status", (evt) => {
      setConnecting(Boolean(evt.payload?.connecting));
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, []);

  return (
    <div className="flex h-full w-full items-center justify-center bg-transparent p-1">
      <div className="flex flex-col items-center">
        <div className="h-[164px] w-[164px] shrink-0">
          <SpinningCube />
        </div>
        {connecting ? <p className="-mt-1 text-[12px] font-medium text-white/85">Connecting...</p> : null}
      </div>
    </div>
  );
}

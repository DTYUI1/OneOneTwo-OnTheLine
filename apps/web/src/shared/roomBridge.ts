// Приложение внутри «комнаты» (intro/): клавиши из iframe до комнаты не доходят,
// поэтому Esc, который не занял сам экран (справка, диалог, карточка, телефон), просит
// комнату «встать из-за компьютера». Протокол — intro/app/room-bridge.js:
// parent.postMessage({ type: "arm112:exit" }), комната принимает только от своего iframe.

type Host = Pick<Window, "addEventListener" | "removeEventListener"> & {
  parent: Pick<Window, "postMessage">;
};

export function bindRoomEscape(host: Host = window): () => void {
  if ((host.parent as unknown) === host) return () => {};
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    // Экранные обработчики стоят в React и на window; решаем после них: если Esc
    // закрыл справку или карточку, они отметили событие preventDefault.
    setTimeout(() => {
      if (!event.defaultPrevented)
        host.parent.postMessage({ type: "arm112:exit" }, "*");
    }, 0);
  };
  host.addEventListener("keydown", onKeyDown);
  return () => host.removeEventListener("keydown", onKeyDown);
}

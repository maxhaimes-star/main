import { useEffect, useState } from 'react';
import { Home } from './Home.tsx';
import { Room } from './Room.tsx';
import { SheetHost } from './sheet.tsx';
import { canonicalRoomId } from '@ojb/shared/src/roomcode.ts';

function useRoute() {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const on = () => setPath(location.pathname);
    window.addEventListener('popstate', on);
    return () => window.removeEventListener('popstate', on);
  }, []);
  return path;
}

export function navigate(to: string) {
  history.pushState(null, '', to);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export function App() {
  const path = useRoute();
  const m = /^\/r\/([a-z0-9]+)/i.exec(path);
  const roomId = m ? canonicalRoomId(m[1]) : null;
  // /r/abcd and /r/ABCD are the same room; show the canonical code in the address bar.
  useEffect(() => {
    if (roomId && location.pathname !== `/r/${roomId}`) history.replaceState(null, '', `/r/${roomId}${location.search}${location.hash}`);
  }, [roomId]);
  return <>{roomId ? <Room key={roomId} roomId={roomId} /> : <Home />}<SheetHost /></>;
}

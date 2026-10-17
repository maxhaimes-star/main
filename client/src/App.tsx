import { useEffect, useState } from 'react';
import { Home } from './Home.tsx';
import { Room } from './Room.tsx';
import { SheetHost } from './sheet.tsx';

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
  return <>{m ? <Room roomId={m[1].toLowerCase()} /> : <Home />}<SheetHost /></>;
}

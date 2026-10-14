import { useEffect, useRef, useState } from 'react';
import type { RoomView } from '@ojb/shared';
import type { Send } from './net.ts';

export function Chat({ view, send }: { view: RoomView; send: Send }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [seen, setSeen] = useState(view.chat.length);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { if (open) { setSeen(view.chat.length); end.current?.scrollIntoView(); } }, [open, view.chat.length]);
  const unread = view.chat.length - seen;
  return (
    <div className={`chat ${open ? 'open' : ''}`}>
      <button className="chat-toggle" onClick={() => setOpen(!open)}>💬 Chat{unread > 0 && !open ? ` (${unread})` : ''}</button>
      {open && (
        <div className="chat-body">
          <div className="chat-msgs">
            {view.chat.map((m, i) => <div key={i}><b>{m.name}:</b> {m.text}</div>)}
            <div ref={end} />
          </div>
          <input value={text} placeholder="Say something…" onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && text.trim()) { send({ t: 'chat', text }); setText(''); } }} />
        </div>
      )}
    </div>
  );
}

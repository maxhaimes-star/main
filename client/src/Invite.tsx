import { useState } from 'react';

export const inviteLink = (roomId: string) => `${location.origin}/r/${roomId}`;

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Older browsers / insecure origins: fall back to a hidden textarea.
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { /* ignore */ }
    ta.remove();
    return ok;
  }
}

/** The room code in big letters, with "Copy invite link" and "Share" (the phone's share sheet, else copy). */
export function InviteBar({ roomId, roomName }: { roomId: string; roomName: string }) {
  const link = inviteLink(roomId);
  const [note, setNote] = useState<string | null>(null);
  const flash = (t: string) => { setNote(t); setTimeout(() => setNote(null), 1800); };
  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';

  async function copy() {
    flash(await copyText(link) ? 'Link copied!' : link);
  }
  async function share() {
    if (canShare) {
      try {
        await navigator.share({ title: `${roomName} · OJB Cube`, text: `Join my cube room ${roomId}`, url: link });
        return;
      } catch (e) {
        if ((e as Error).name === 'AbortError') return;
      }
    }
    await copy();
  }

  return (
    <div className="invite">
      <div className="invite-code">
        <span className="invite-label">Room code</span>
        <span className="code" aria-label="Room code">{roomId}</span>
      </div>
      <div className="invite-actions">
        <button className="primary" onClick={copy}>Copy invite link</button>
        <button onClick={share}>Share</button>
        <span className="invite-link muted">{note ?? link.replace(/^https?:\/\//, '')}</span>
      </div>
    </div>
  );
}

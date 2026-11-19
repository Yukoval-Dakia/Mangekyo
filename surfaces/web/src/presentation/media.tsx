import { useEffect, useRef, useState } from 'react';
export type ResolveAsset = (assetId: string) => Blob | null | Promise<Blob | null>;
const accepted = {
  image: ['image/jpeg', 'image/png', 'image/webp'],
  audio: ['audio/wav', 'audio/mpeg', 'audio/ogg'],
};
export function Asset({
  id,
  label,
  media,
  resolve,
}: {
  id: string;
  label: string;
  media: 'image' | 'audio';
  resolve?: ResolveAsset | undefined;
}) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    let active = true;
    let owned = '';
    setUrl('');
    Promise.resolve()
      .then(() => resolve?.(id))
      .then((blob) => {
        if (
          active &&
          blob instanceof Blob &&
          blob.size <= 16 * 1024 * 1024 &&
          accepted[media].includes(blob.type)
        ) {
          owned = URL.createObjectURL(blob);
          setUrl(owned);
        }
      })
      .catch(() => {});
    return () => {
      active = false;
      if (owned) URL.revokeObjectURL(owned);
    };
  }, [id, media, resolve]);
  if (!url) return <p>{label}（媒体暂无可用预览）</p>;
  const failed = () => setUrl('');
  return media === 'image' ? (
    <img src={url} alt={label} onError={failed} />
  ) : (
    <audio controls src={url} aria-label={label} onError={failed} />
  );
}

export function Audition({
  lanes,
  bpm,
  label,
}: {
  lanes: boolean[][];
  bpm: number;
  label: string;
}) {
  const ctx = useRef<AudioContext | null>(null);
  const [message, setMessage] = useState('');
  useEffect(
    () => () => {
      const audio = ctx.current;
      ctx.current = null;
      if (audio && audio.state !== 'closed') void audio.close();
    },
    [],
  );
  async function play() {
    const previous = ctx.current;
    ctx.current = null;
    if (previous && previous.state !== 'closed') void previous.close();
    let audio: AudioContext | null = null;
    try {
      audio = new AudioContext();
      const playing = audio;
      ctx.current = audio;
      await audio.resume();
      if (ctx.current !== audio) return;
      const beat = 30 / bpm,
        start = audio.currentTime + 0.03;
      lanes.forEach((lane, voice) =>
        lane.forEach((on, i) => {
          if (!on) return;
          const oscillator = playing.createOscillator(),
            gain = playing.createGain();
          const when = start + i * beat;
          oscillator.type = voice % 2 === 0 ? 'sine' : 'triangle';
          oscillator.frequency.setValueAtTime(104 + voice * 100, when);
          oscillator.frequency.exponentialRampToValueAtTime(48 + voice * 72, when + 0.09);
          gain.gain.setValueAtTime(0.18, when);
          gain.gain.exponentialRampToValueAtTime(0.001, when + 0.12);
          oscillator.connect(gain).connect(playing.destination);
          oscillator.start(when);
          oscillator.stop(when + 0.13);
        }),
      );
      setMessage(lanes.some((l) => l.some(Boolean)) ? '正在试听' : '这一小节全是休止');
      window.setTimeout(
        () => {
          if (ctx.current === playing) {
            ctx.current = null;
            void playing.close();
            setMessage('试听结束');
          }
        },
        1000 * (beat * lanes[0]!.length + 0.16),
      );
    } catch {
      if (ctx.current !== audio) return;
      if (audio && audio.state !== 'closed') void audio.close();
      ctx.current = null;
      setMessage('试听不可用，可按格号阅读两组落点。');
    }
  }
  return (
    <div>
      <button type="button" className="tonal-button" onClick={play}>
        {label}
      </button>{' '}
      <small role="status">{message}</small>
    </div>
  );
}

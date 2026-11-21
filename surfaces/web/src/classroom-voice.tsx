import { useEffect, useRef, useState } from 'react';

type Recognition = {
  lang: string;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
};

function recognizer() {
  const browser = window as Window & {
    SpeechRecognition?: new () => Recognition;
    webkitSpeechRecognition?: new () => Recognition;
  };
  return browser.SpeechRecognition ?? browser.webkitSpeechRecognition;
}

export function Dictation({ append }: { append(text: string): void }) {
  const active = useRef<Recognition | null>(null);
  const [listening, setListening] = useState(false);
  const [notice, report] = useState('');
  const callback = useRef(append);
  callback.current = append;
  useEffect(() => {
    function abort() {
      const current = active.current;
      active.current = null;
      current?.abort();
      setListening(false);
    }
    function onVisibility() { if (document.hidden) abort(); }
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', abort);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', abort);
      abort();
    };
  }, []);
  function toggle() {
    if (active.current) { active.current.stop(); return; }
    const Engine = recognizer();
    if (!Engine) return;
    const recognition = new Engine();
    recognition.lang = 'zh-CN';
    recognition.onresult = event => {
      if (active.current !== recognition) return;
      const text = Array.from(event.results).slice(event.resultIndex).filter(result => result.isFinal).map(result => result[0].transcript).join('').trim();
      if (text) callback.current(text);
    };
    recognition.onerror = event => {
      if (active.current === recognition)
        report(event.error === 'not-allowed' ? '麦克风未获授权，可继续打字。' : '未能完成转写，可重试或打字。');
    };
    recognition.onend = () => {
      if (active.current !== recognition) return;
      active.current = null;
      setListening(false);
    };
    try {
      active.current = recognition;
      recognition.start();
      setListening(true);
      report('');
    } catch {
      active.current = null;
      report('无法开始口述，请检查麦克风权限。');
    }
  }
  return <div>
    <button type="button" className="tonal-button" disabled={!recognizer()} aria-pressed={listening} onClick={toggle}>
      {listening ? '结束口述' : '口述输入'}
    </button>
    <small>{recognizer() ? '使用浏览器语音服务，可能在线转写。可编辑后发送。' : '此浏览器不支持口述，可使用系统听写。'}</small>
    {notice && <span role="status">{notice}</span>}
  </div>;
}

let stopCurrentReading: (() => void) | undefined;

export function ReadAloud({ text }: { text: string }) {
  const active = useRef<SpeechSynthesisUtterance | null>(null);
  const [reading, setReading] = useState(false);
  const [notice, report] = useState('');
  const speech = window.speechSynthesis;
  function stop() {
    if (!active.current) return;
    active.current = null;
    stopCurrentReading = undefined;
    speech.cancel();
    setReading(false);
  }
  useEffect(() => {
    function onVisibility() { if (document.hidden) stop(); }
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', stop);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', stop);
      stop();
    };
  }, [text]);
  if (!speech) return null;
  function toggle() {
    if (reading) { stop(); return; }
    stopCurrentReading?.();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'zh-CN';
    const voice = speech.getVoices().find(v => v.localService && v.lang.startsWith('zh'));
    if (!voice) { report('本机暂无可用的中文朗读声音。'); return; }
    utterance.voice = voice;
    active.current = utterance;
    stopCurrentReading = stop;
    const end = () => {
      if (active.current !== utterance) return;
      active.current = null;
      stopCurrentReading = undefined;
      setReading(false);
    };
    utterance.onend = end;
    utterance.onerror = event => {
      if (active.current === utterance && !['canceled', 'interrupted'].includes(event.error)) report('朗读服务暂不可用。');
      end();
    };
    report('');
    setReading(true);
    speech.speak(utterance);
  }
  return <><button type="button" className="text-button" aria-pressed={reading} onClick={toggle}>
    {reading ? '停止朗读' : '朗读回复'}</button>{notice && <small role="status">{notice}</small>}</>;
}

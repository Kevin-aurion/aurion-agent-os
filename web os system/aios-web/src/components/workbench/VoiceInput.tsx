'use client';

import { useEffect, useRef, useState } from 'react';
import { Mic, MicOff } from 'lucide-react';
import { API } from '@/lib/api';
import { cn } from '@/lib/cn';
import { Spinner } from '@/components/ui';

/** Mic → OpenAI Whisper via `/api/voice/transcribe`. Extracted from employee TrainingTab. */
export function VoiceInput({
  onTranscript,
  disabled,
}: {
  onTranscript: (text: string) => void;
  disabled?: boolean;
}) {
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mediaRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    return () => {
      mediaRef.current?.stop();
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  async function start() {
    setError(null);
    if (typeof MediaRecorder === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      setError('此瀏覽器不支援麥克風錄音');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      chunksRef.current = [];
      const mime = MediaRecorder.isTypeSupported('audio/webm')
        ? 'audio/webm'
        : MediaRecorder.isTypeSupported('audio/mp4')
          ? 'audio/mp4'
          : '';
      const rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
      mediaRef.current = rec;
      rec.ondataavailable = (ev) => {
        if (ev.data.size > 0) chunksRef.current.push(ev.data);
      };
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
        const blob = new Blob(chunksRef.current, { type: rec.mimeType || 'audio/webm' });
        chunksRef.current = [];
        if (!blob.size) {
          setError('沒有錄到音訊');
          setBusy(false);
          setRecording(false);
          return;
        }
        setBusy(true);
        try {
          const form = new FormData();
          const ext = blob.type.includes('mp4') ? 'm4a' : 'webm';
          form.append('file', blob, `voice.${ext}`);
          const res = await API.upload<{ text: string }>('/api/voice/transcribe', form);
          const text = (res.text ?? '').trim();
          if (!text) setError('轉錄結果為空');
          else onTranscript(text);
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        } finally {
          setBusy(false);
          setRecording(false);
        }
      };
      rec.start();
      setRecording(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : '無法開啟麥克風');
    }
  }

  function stop() {
    const rec = mediaRef.current;
    if (rec && rec.state !== 'inactive') {
      setBusy(true);
      rec.stop();
    }
    mediaRef.current = null;
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        className={cn('btn-ghost h-9 w-9 shrink-0 p-0', recording && 'bg-rose-500/15 text-rose-400')}
        title={recording ? '停止錄音並轉錄' : '語音輸入（音訊會送往 OpenAI 轉錄）'}
        disabled={disabled || busy}
        onClick={() => (recording ? stop() : void start())}
      >
        {busy ? (
          <Spinner className="h-4 w-4" />
        ) : recording ? (
          <MicOff className="h-4 w-4" />
        ) : (
          <Mic className="h-4 w-4" />
        )}
      </button>
      <p className="max-w-[10rem] text-right text-[10px] leading-tight text-muted">音訊會送往 OpenAI 轉錄</p>
      {error && <p className="max-w-[12rem] text-right text-[10px] text-rose-400">{error}</p>}
    </div>
  );
}

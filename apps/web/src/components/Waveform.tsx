import { useEffect, useRef } from 'react';

// Live waveform rendered from a MediaStream via Web Audio's AnalyserNode.
// We avoid spinning up a wavesurfer.js instance for the live capture
// because the AnalyserNode + canvas pattern is one tight loop with no
// extra dependencies on the hot path. wavesurfer.js stays in the deps
// list for static playback in the note detail view (future change).

interface WaveformProps {
  stream: MediaStream | null;
  height?: number;
  color?: string;
  background?: string;
}

export default function Waveform({
  stream,
  height = 80,
  color = '#FFFFFF',
  background = 'transparent',
}: WaveformProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !stream) return;

    const ctxAudio = new (window.AudioContext || (window as any).webkitAudioContext)();
    const analyser = ctxAudio.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.85;
    const source = ctxAudio.createMediaStreamSource(stream);
    source.connect(analyser);

    const data = new Uint8Array(analyser.frequencyBinCount);
    const ctx2d = canvas.getContext('2d');
    if (!ctx2d) return;

    const draw = () => {
      analyser.getByteFrequencyData(data);
      const w = canvas.width;
      const h = canvas.height;
      ctx2d.clearRect(0, 0, w, h);
      if (background !== 'transparent') {
        ctx2d.fillStyle = background;
        ctx2d.fillRect(0, 0, w, h);
      }
      const barCount = 48;
      const barW = (w - (barCount - 1) * 2) / barCount;
      const step = Math.floor(data.length / barCount);
      ctx2d.fillStyle = color;
      for (let i = 0; i < barCount; i++) {
        const v = data[i * step] / 255;
        const barH = Math.max(2, v * h);
        const x = i * (barW + 2);
        const y = (h - barH) / 2;
        ctx2d.fillRect(x, y, barW, barH);
      }
      rafRef.current = requestAnimationFrame(draw);
    };
    draw();

    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      try { source.disconnect(); } catch (_e) { /* silent-catch-ok: the node is already disconnected on teardown */ }
      ctxAudio.close().catch((closeErr) => console.warn('waveform_audioctx_close_failed', closeErr));
    };
  }, [stream, color, background]);

  return (
    <canvas
      ref={canvasRef}
      width={320}
      height={height}
      style={{ width: '100%', height, display: 'block' }}
    />
  );
}

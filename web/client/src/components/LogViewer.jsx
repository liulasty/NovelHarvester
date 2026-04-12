import { useEffect, useRef, useState } from 'react';

function lineClass(stream, text) {
  if (stream === 'stderr' || /error|错误|失败|ERR/i.test(text)) return 'log-line log-err';
  if (/✓|OK|ok|成功/.test(text)) return 'log-line log-ok';
  return 'log-line log-info';
}

/**
 * @param {{ taskId: string; variant?: 'short' | 'tall' }} props
 */
export default function LogViewer({ taskId, variant = 'short' }) {
  const [lines, setLines] = useState([]);
  const bottom = useRef(null);

  useEffect(() => {
    if (!taskId) return undefined;
    const es = new EventSource(`/api/tasks/${encodeURIComponent(taskId)}/log`);
    es.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'line') {
          setLines((prev) => [...prev.slice(-400), msg]);
        }
        if (msg.type === 'exit' || msg.type === 'killed') {
          es.close();
        }
      } catch {
        // ignore
      }
    };
    es.onerror = () => {
      es.close();
    };
    return () => es.close();
  }, [taskId]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [lines]);

  const boxClass = variant === 'tall' ? 'log-box tall' : 'log-box short';
  return (
    <div className={boxClass}>
      {lines.map((l, i) => (
        <div key={`${i}-${l.text}`} className={lineClass(l.stream, l.text)}>
          {l.text}
        </div>
      ))}
      <div ref={bottom} />
    </div>
  );
}

import React from 'react';
import { createRoot } from 'react-dom/client';
import {
  RadarChart,
  PolarGrid,
  PolarAngleAxis,
  PolarRadiusAxis,
  Radar,
  Tooltip
} from 'recharts';

function RadarTooltip({ active, payload }) {
  if (!active || !payload || !payload.length) return null;
  const row = payload[0].payload;
  return (
    <div style={{
      background: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--border-strong)',
      borderRadius: 8, padding: '0.5rem 0.7rem', fontSize: 13, boxShadow: 'var(--shadow)'
    }}>
      <strong>{row.dimension}</strong>
      <div>{row.available === false ? 'Section not detected' : `${row.score}%`}</div>
    </div>
  );
}

export function MatchRadar({ dimensions, width }) {
  const data = (dimensions || []).map(d => ({ ...d, score: Number(d.score) || 0 }));
  if (!data.length) return null;
  return (
    <RadarChart width={width} height={320} cx="50%" cy="50%" outerRadius="72%" data={data}>
      <PolarGrid stroke="var(--border-strong)" />
      <PolarAngleAxis dataKey="dimension" tick={{ fill: 'var(--text-2)', fontSize: 13 }} />
      <PolarRadiusAxis angle={90} domain={[0, 100]} tick={{ fill: 'var(--text-3)', fontSize: 11 }} tickCount={5} />
      <Radar
        name="Your resume"
        dataKey="score"
        stroke="var(--accent)"
        fill="var(--accent)"
        fillOpacity={0.28}
        strokeWidth={2}
        isAnimationActive={false}
      />
      <Tooltip content={<RadarTooltip />} />
    </RadarChart>
  );
}

// Mount helper used by public/js/app.js. The chart is sized from the container
// (it must be visible when called) and re-sized when the window changes.
window.renderMatchRadar = function renderMatchRadar(containerId, dimensions) {
  const container = document.getElementById(containerId);
  if (!container) return;
  if (!container._reactRoot) container._reactRoot = createRoot(container);
  container._dimensions = dimensions;
  const draw = () => {
    const width = Math.max(260, container.clientWidth || 0);
    container._reactRoot.render(React.createElement(MatchRadar, { dimensions: container._dimensions, width }));
  };
  draw();
  if (!container._resizeBound) {
    container._resizeBound = true;
    let timer = null;
    window.addEventListener('resize', () => {
      clearTimeout(timer);
      timer = setTimeout(() => { if (container.clientWidth) draw(); }, 150);
    });
  }
};

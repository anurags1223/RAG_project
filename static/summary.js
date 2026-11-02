'use strict';
// SVG is built from a fixed template; model text is always escaped.
function summaryDiagram(summary) {
  const xml = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
  const wrap = (value, size = 30) => {
    const words = String(value).split(/\s+/), lines = [''];
    for (const word of words) {
      const i = lines.length - 1;
      if (lines[i] && (lines[i] + ' ' + word).length > size) lines.push(word);
      else lines[i] += (lines[i] ? ' ' : '') + word;
    }
    return lines.flatMap(line => line.length > size ? line.match(new RegExp('.{1,' + size + '}', 'g')) : [line]);
  };
  const label = (text, x, y, size = 30) => wrap(text, size).map((line, i) => `<tspan x="${x}" y="${y + i * 21}">${xml(line)}</tspan>`).join('');
  const short = (text, limit) => text.length > limit ? text.slice(0,limit-1).trimEnd() + '…' : text;
  const process = summary.visual_type === 'process';
  const height = process ? 70 + summary.points.length * 120 : 140 + Math.ceil(summary.points.length / 2) * 125;
  let drawing = `<rect width="640" height="${height}" rx="16" fill="#fbf4e4"/><text x="32" y="34" fill="#876333" font-size="12" letter-spacing="2">${process ? 'STEP BY STEP' : 'CONCEPT MAP'}</text>`;
  if (!process) drawing += `<rect x="130" y="52" width="380" height="70" rx="10" fill="#163e53"/><text text-anchor="middle" fill="#fff7e6" font-size="17">${label(short(summary.title,65),320,77,36)}</text>`;
  summary.points.forEach((point, i) => {
    const x = process ? 60 : 30 + (i % 2) * 310;
    const y = process ? 60 + i * 120 : 155 + Math.floor(i / 2) * 125;
    const width = process ? 520 : 280;
    if (process && i) drawing += `<path d="M320 ${y - 28}v22m-5 -6 5 6 5 -6" stroke="#b58b45" stroke-width="2" fill="none"/>`;
    if (!process) drawing += `<path d="M320 122V${y-14}H${x + width/2}V${y}" fill="none" stroke="#c6ac7c" stroke-width="1.5"/>`;
    drawing += `<rect x="${x}" y="${y}" width="${width}" height="92" rx="10" fill="#fffaf0" stroke="#c6ac7c"/><circle cx="${x+24}" cy="${y+26}" r="13" fill="${process ? '#a16e32' : '#163e53'}"/><text x="${x+24}" y="${y+31}" fill="white" text-anchor="middle" font-size="13">${i+1}</text><text fill="#152438" font-size="16">${label(short(point.title,process ? 90 : 58),x+48,y+26,process ? 47 : 23)}</text><text x="${x+width-16}" y="${y+79}" text-anchor="end" fill="#876333" font-size="11">[${point.source}]</text>`;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 ${height}" width="640" height="${height}" role="img" aria-label="${xml(summary.title)}" style="font-family:Georgia,serif;stroke:none;fill:none"><title>${xml(summary.title)}</title>${drawing}</svg>`;
}

function renderVisualSummary(node, summary, sources) {
  const area = node.querySelector('.answer-text');
  const coverage = summary.coverage;
  const note = coverage.sampled ? `Based on ${coverage.passages} of ${coverage.total} indexed passages across ${coverage.documents} PDF(s). Some details may be omitted.` : `Based on all ${coverage.total} indexed passage${coverage.total === 1 ? '' : 's'} in ${coverage.documents} PDF(s).`;
  area.innerHTML = `<section class="visual-summary"><div class="summary-eyebrow">DOCUMENT SUMMARY</div><h2>${esc(summary.title)}</h2><p class="summary-overview">${renderAnswer(summary.overview,sources)}</p><p class="summary-coverage">${esc(note)}</p><div class="summary-visual-heading"><h3>${summary.visual_type === 'process' ? 'How it works' : 'At a glance'}</h3><button class="download-visual" type="button">Download SVG ↓</button></div><div class="summary-diagram">${summaryDiagram(summary)}</div><h3>Key takeaways</h3><div class="takeaway-grid">${summary.points.map((p,i) => `<div class="takeaway-card"><span class="takeaway-number">${String(i+1).padStart(2,'0')}</span><div><h4>${esc(p.title)}</h4><p>${renderAnswer(p.text,sources)} ${p.text.includes(`[${p.source}]`) ? '' : `<button class="inline-citation" data-cite="${p.source}" aria-label="View source ${p.source}">[${p.source}]</button>`}</p></div></div>`).join('')}</div></section>`;
  area.querySelectorAll('[data-cite]').forEach(button => button.onclick = () => showSources(sources,sources.findIndex(s => s.number === +button.dataset.cite)));
  area.querySelector('.download-visual').onclick = () => {
    const url = URL.createObjectURL(new Blob([summaryDiagram(summary)],{type:'image/svg+xml'}));
    const link = document.createElement('a'); link.href = url; link.download = 'document-summary.svg'; link.click();
    setTimeout(() => URL.revokeObjectURL(url),1000);
  };
}

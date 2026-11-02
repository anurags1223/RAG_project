'use strict';
const $ = (selector) => document.querySelector(selector);
const icon = (name) => `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let config = {}, docs = [], conversations = [], selected = new Set(), activeId = null;
let controller = null, currentSources = [], sourceIndex = 0, sourcePage = 1, zoom = 100;
let toastTimer, polling = false, refreshModelsId = 0;
const providerNames = {ollama:'Ollama', lmstudio:'LM Studio'};
const pdfPreview = import('/pdf-preview.js');
const sourceEmptyMarkup = $('#source-content').innerHTML;
const fileSize = bytes => bytes < 1048576 ? `${Math.max(1,Math.round(bytes/1024))} KB` : `${(bytes/1048576).toFixed(1)} MB`;

async function api(path, options = {}) {
  const response = await fetch('/api' + path, options);
  if (!response.ok) {
    let detail;
    try { detail = (await response.json()).detail; } catch { detail = response.statusText; }
    throw new Error(typeof detail === 'string' ? detail : JSON.stringify(detail));
  }
  return response.json();
}
function jsonOptions(method, body) { return {method, headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)}; }
function toast(text) { clearTimeout(toastTimer); $('#toast').textContent = text; $('#toast').hidden = false; toastTimer = setTimeout(() => $('#toast').hidden = true, 6500); }
function guard(fn) { return (...args) => Promise.resolve().then(() => fn(...args)).catch(e => toast(e.message)); }
function busy() { return !!controller; }
function emptyChat() {
  $('#messages').innerHTML = `<div class="empty-state"><div class="empty-compass" aria-hidden="true">☸</div><h2>Turn your PDFs into a clear picture.</h2><p>Upload your documents, then choose Summarize for key takeaways and a visual guide. Ask follow-up questions below.</p><button class="primary-button" id="empty-upload">Upload a PDF</button></div>`;
  $('#empty-upload').onclick = () => $('#file-input').click();
}
function newChat() {
  if (busy()) return toast('Stop the current answer before starting a new chat.');
  activeId = null; emptyChat(); $('#question').value = ''; $('#question').focus();
  currentSources = []; $('#source-content').innerHTML = sourceEmptyMarkup;
  $('#sidebar').classList.remove('open');
}
function readyDocs() { return docs.filter(d => d.status === 'ready'); }
function selectionText() {
  const count = readyDocs().filter(d => selected.has(d.id)).length;
  $('#selection-button').textContent = count === readyDocs().length ? `All ready documents${count ? ` (${count})` : ''}` : `${count} document${count === 1 ? '' : 's'} selected`;
}
function drawDocs() {
  const list = $('#document-list');
  list.innerHTML = docs.length ? '' : '<div class="side-empty">No documents yet.<br>Upload a PDF to get started.</div>';
  for (const d of docs) {
    const button = document.createElement('button');
    button.className = 'document-item' + (selected.has(d.id) ? ' selected' : '');
    const state = {ready:'Ready',indexing:'Indexing…',error:'Needs attention',needs_index:'Re-index needed'}[d.status];
    button.title = `${d.name} — ${d.error || state}`;
    button.innerHTML = `<span class="pdf-icon">${icon('file')}</span><span class="file-info"><strong>${esc(d.name)}</strong><small>${d.pages ? `${d.pages} page${d.pages === 1 ? '' : 's'} · ` : ''}${fileSize(d.size)} · ${state}</small></span><span class="file-state ${esc(d.status)}"></span>`;
    button.onclick = () => { if (d.status !== 'ready') return openLibrary(); showSources([{document_id:d.id,name:d.name,page:1,text:'',number:1}]); };
    list.append(button);
  }
  selectionText();
  if ($('#library-dialog').open) drawLibrary();
}
async function refreshDocs() {
  const old = new Map(docs.map(d => [d.id,d.status]));
  docs = await api('/documents');
  const valid = new Set(docs.map(d => d.id));
  selected = new Set([...selected].filter(id => valid.has(id)));
  for (const d of docs) if (d.status === 'ready' && (!old.has(d.id) || old.get(d.id) === 'indexing')) selected.add(d.id);
  drawDocs();
}
async function refreshModels() {
  const requestId = ++refreshModelsId;
  const provider = config.provider;
  $('#connection-text').textContent = 'Checking server…';
  const result = await api('/models?kind=' + provider);
  if (requestId !== refreshModelsId) return result;
  $('#status-dot').classList.toggle('connected', result.connected);
  $('#connection-text').textContent = result.connected ? `${providerNames[provider]} connected` : `${providerNames[provider]} offline`;
  $('#connection-text').title = result.error || '';
  const select = $('#model-select');
  select.innerHTML = '<option value="">Choose model</option>';
  // Embedding models remain available in settings, but are not offered as chat defaults.
  const names = result.models.filter(m => !/embed|bge-|e5-|gte-/i.test(m));
  if (config.chat_model && !names.includes(config.chat_model)) names.unshift(config.chat_model);
  for (const name of names) select.add(new Option(name, name));
  select.value = config.chat_model;
  $('#model-options').innerHTML = result.models.map(m => `<option value="${esc(m)}"></option>`).join('');
  return result;
}
function fillSettings() {
  for (const [key,value] of Object.entries(config)) {
    const input = $('#settings-form').elements.namedItem(key); if (input) input.value = value;
  }
}
function openSettings() { fillSettings(); $('#settings-status').textContent = ''; $('#settings-dialog').showModal(); }
async function saveConfig(value) {
  config = await api('/settings', jsonOptions('PUT', value));
  $('#provider-select').value = config.provider;
  await Promise.all([refreshDocs(), refreshModels()]);
}
async function uploadFiles(files) {
  for (const file of files) {
    const data = new FormData(); data.append('file', file);
    $('#activity').textContent = `Uploading ${file.name}…`;
    try { await api('/documents', {method:'POST', body:data}); }
    catch (e) { toast(`${file.name}: ${e.message}`); }
  }
  $('#activity').textContent = ''; $('#file-input').value = '';
  await refreshDocs(); toast('Upload finished. Indexing status is shown in Documents.');
}
function drawLibrary() {
  const root = $('#library-list'); root.innerHTML = '';
  if (!docs.length) root.innerHTML = '<p class="empty-note">No PDFs yet. Add a text-based PDF to begin.</p>';
  for (const d of docs) {
    const row = document.createElement('div'); row.className = 'library-row';
    row.innerHTML = `<input type="checkbox" aria-label="Use ${esc(d.name)}" ${selected.has(d.id) ? 'checked' : ''} ${d.status !== 'ready' ? 'disabled' : ''}><span class="pdf-icon">${icon('file')}</span><div class="details"><strong>${esc(d.name)}</strong><small>${d.pages || '—'} pages · ${d.chunks} passages · ${esc(d.status.replace('_',' '))}</small>${d.error ? `<div class="library-error">${esc(d.error)}</div>` : ''}</div><div class="row-actions"><button data-reindex ${d.status === 'indexing' ? 'disabled' : ''}>Re-index</button><button data-delete aria-label="Delete ${esc(d.name)}" ${d.status === 'indexing' ? 'disabled' : ''}>${icon('trash')}</button></div>`;
    row.querySelector('input').onchange = e => { if (e.target.checked) selected.add(d.id); else selected.delete(d.id); drawDocs(); };
    row.querySelector('[data-reindex]').onclick = guard(async () => { await api(`/documents/${d.id}/reindex`,{method:'POST'}); await refreshDocs(); });
    row.querySelector('[data-delete]').onclick = guard(async () => { if (!confirm(`Delete ${d.name} and its search index?`)) return; await api(`/documents/${d.id}`,{method:'DELETE'}); await refreshDocs(); if (currentSources.some(s => s.document_id === d.id)) closeSource(); });
    root.append(row);
  }
}
function openLibrary() { drawLibrary(); if (!$('#library-dialog').open) $('#library-dialog').showModal(); }
async function openHistory() {
  conversations = await api('/conversations');
  const root = $('#history-list'); root.innerHTML = '';
  if (!conversations.length) root.innerHTML = '<p class="empty-note">Your conversations will appear here after your first question.</p>';
  for (const c of conversations) {
    const row = document.createElement('div'); row.className = 'history-row';
    row.innerHTML = `${icon('chat')}<button class="details"><strong>${esc(c.title)}</strong><small>${esc(c.updated)}</small></button><button class="icon-button" aria-label="Delete conversation">${icon('trash')}</button>`;
    row.querySelector('.details').onclick = guard(async () => {
      if (busy()) return toast('Stop the current answer before opening another chat.');
      const messages = await api('/conversations/' + c.id); activeId = c.id;
      $('#messages').innerHTML = ''; for (const m of messages) addMessage(m.role, m.content, m.sources || [], m.summary);
      $('#history-dialog').close(); scrollChat();
    });
    row.querySelector('.icon-button').onclick = guard(async () => {
      if (busy()) return toast('Stop the current answer first.');
      if (!confirm('Delete this conversation?')) return;
      await api('/conversations/' + c.id, {method:'DELETE'}); if (activeId === c.id) newChat(); await openHistory();
    });
    root.append(row);
  }
  if (!$('#history-dialog').open) $('#history-dialog').showModal();
}
function scrollChat() { const el = $('#messages'); el.scrollTop = el.scrollHeight; }
function nearBottom() { const el = $('#messages'); return el.scrollHeight - el.scrollTop - el.clientHeight < 120; }
function renderAnswer(text, sources) {
  // Escape first. Model and PDF content never become executable HTML.
  return esc(text).replace(/\*\*([^*\n]+)\*\*/g,'<strong>$1</strong>').replace(/`([^`\n]+)`/g,'<code>$1</code>').replace(/\[(\d+)\]/g,(full,n) => sources.some(s => s.number === +n) ? `<button class="inline-citation" data-cite="${n}" aria-label="View source ${n}">[${n}]</button>` : full);
}
function updateAnswer(node, text, sources) {
  node.querySelector('.answer-text').innerHTML = renderAnswer(text, sources);
  node.querySelectorAll('[data-cite]').forEach(b => b.onclick = () => showSources(sources, sources.findIndex(s => s.number === +b.dataset.cite)));
}
function sourceChips(node, sources) {
  const root = node.querySelector('.source-chips'); root.innerHTML = '';
  const seen = new Set();
  sources.forEach((s,i) => {
    const key = `${s.document_id}:${s.page}`; if (seen.has(key)) return; seen.add(key);
    const button = document.createElement('button'); button.className = 'source-chip';
    button.innerHTML = `${icon('file')}<span>${s.number} · ${esc(s.name)} · p. ${s.page}</span>${icon('chevron')}`;
    button.onclick = () => showSources(sources,i); root.append(button);
  });
}
function addMessage(role, text = '', sources = [], summary = null) {
  $('.empty-state')?.remove();
  const node = document.createElement('article'); node.className = 'message ' + role;
  if (role === 'user') node.innerHTML = `<div class="avatar" aria-hidden="true"></div><div class="message-body"><div class="bubble">${esc(text)}</div><div class="message-time">You</div></div>`;
  else {
    node.innerHTML = `<div class="avatar" aria-hidden="true"></div><div class="message-body"><div class="answer-text"></div><div class="source-chips"></div><div class="message-actions"><button class="copy-button">${icon('copy')}Copy</button><span class="answer-timing"></span></div></div>`;
    updateAnswer(node,text,sources); if (summary) renderVisualSummary(node,summary,sources); sourceChips(node,sources);
    node.querySelector('.copy-button').onclick = guard(async () => { await navigator.clipboard.writeText(node.querySelector('.answer-text').innerText); toast('Answer copied.'); });
  }
  $('#messages').append(node); return node;
}
function showSources(sources, index = 0) {
  currentSources = sources; sourceIndex = index; sourcePage = sources[index].page; zoom = 100;
  $('.app').classList.remove('source-closed'); $('#source-panel').classList.add('opened'); $('#reopen-source').hidden = true; drawSource();
}
function closeSource() { $('.app').classList.add('source-closed'); $('#source-panel').classList.remove('opened'); $('#reopen-source').hidden = false; }
function drawSource() {
  const s = currentSources[sourceIndex]; if (!s) return;
  const d = docs.find(x => x.id === s.document_id);
  const url = `/api/documents/${encodeURIComponent(s.document_id)}/file`;
  $('#source-content').innerHTML = `<div class="source-controls"><button class="prev" aria-label="Previous source" ${sourceIndex === 0 ? 'disabled' : ''}>${icon('chevron')}</button><span>${sourceIndex + 1} of ${currentSources.length} sources</span><button class="next" aria-label="Next source" ${sourceIndex === currentSources.length - 1 ? 'disabled' : ''}>${icon('chevron')}</button></div><div class="source-name"><span class="pdf-icon">${icon('file')}</span><span class="file-info"><strong>${esc(s.name)}</strong><small>Page ${sourcePage}${d?.pages ? ` of ${d.pages}` : ''}</small></span></div><div class="page-controls"><label>Page <input id="source-page" type="number" min="1" max="${d?.pages || 99999}" value="${sourcePage}" aria-label="PDF page"></label><span style="flex:1"></span><button id="zoom-out" aria-label="Zoom out">−</button><span>${zoom}%</span><button id="zoom-in" aria-label="Zoom in">+</button></div><div class="pdf-viewer" id="pdf-viewer" aria-label="PDF source page"></div>${s.text ? `<details class="excerpt-details"><summary>Retrieved passage</summary><div class="source-excerpt" aria-label="Retrieved passage">${esc(s.text)}</div></details>` : ''}<a class="source-link" href="${url}#page=${sourcePage}" target="_blank" rel="noopener">${icon('link')}Open document</a>`;
  const viewer = $('#pdf-viewer'), page = sourcePage, currentZoom = zoom;
  pdfPreview.then(module => module.renderPDF(viewer,url,page,currentZoom,s.text)).catch(() => { if (viewer.isConnected) viewer.textContent = 'PDF renderer unavailable. Use Open document below.'; });
  $('.source-controls .prev').onclick = () => { sourceIndex--; sourcePage = currentSources[sourceIndex].page; drawSource(); };
  $('.source-controls .next').onclick = () => { sourceIndex++; sourcePage = currentSources[sourceIndex].page; drawSource(); };
  $('#source-page').onchange = e => { sourcePage = Math.max(1,Math.min(d?.pages || 99999,+e.target.value || 1)); drawSource(); };
  $('#zoom-out').onclick = () => { zoom = Math.max(50,zoom-25); drawSource(); };
  $('#zoom-in').onclick = () => { zoom = Math.min(200,zoom+25); drawSource(); };
}
async function sendQuestion(event, mode = 'chat') {
  event.preventDefault();
  if (busy()) { controller.abort(); return; }
  const question = mode === 'summary' ? 'Summarize the selected PDFs with key takeaways and a visual explanation.' : $('#question').value.trim(); if (!question) return;
  if (!config.chat_model) { openSettings(); return toast('Choose a chat model first.'); }
  const ids = readyDocs().filter(d => selected.has(d.id)).map(d => d.id);
  if (!ids.length) { openLibrary(); return toast('Upload and select at least one ready PDF.'); }
  addMessage('user',question); const node = addMessage('assistant'); node.classList.add('streaming');
  if (mode === 'chat') { $('#question').value = ''; $('#question').style.height = 'auto'; }
  controller = new AbortController(); const requestController = controller;
  $('#send-button').innerHTML = icon('stop'); $('#send-button').ariaLabel = 'Stop answer';
  $('#activity').textContent = mode === 'summary' ? 'Reading selected documents…' : 'Finding relevant passages…';
  $('#summarize-button').disabled = true;
  $('#model-select').disabled = true; $('#provider-select').disabled = true;
  let answer = '', sources = [], frame = 0, finished = false, summary = null;
  const paint = () => { frame = 0; const shouldScroll = nearBottom(); if (summary) renderVisualSummary(node,summary,sources); else updateAnswer(node,answer,sources); if (shouldScroll) scrollChat(); };
  scrollChat();
  try {
    const response = await fetch('/api/chat', {...jsonOptions('POST',{question,conversation_id:activeId,document_ids:ids,mode}), signal:requestController.signal});
    if (!response.ok) { const data = await response.json(); throw new Error(data.detail || 'Unable to start answer.'); }
    const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = '';
    const consume = line => {
      if (!line.trim()) return; const item = JSON.parse(line);
      if (item.type === 'start') activeId = item.conversation_id;
      if (item.type === 'sources') { sources = item.sources; sourceChips(node,sources); $('#activity').textContent = mode === 'summary' ? 'Creating your summary and visual guide…' : 'Writing answer…'; }
      if (item.type === 'summary') { summary = item.summary; answer = item.text; paint(); }
      if (item.type === 'token') { answer += item.text; if (!frame) frame = requestAnimationFrame(paint); }
      if (item.type === 'error') throw new Error(item.message);
      if (item.type === 'done') { finished = true; node.querySelector('.answer-timing').textContent = `${item.seconds}s`; }
    };
    while (true) { const {value,done} = await reader.read(); buffer += decoder.decode(value || new Uint8Array(),{stream:!done}); const lines = buffer.split('\n'); buffer = lines.pop(); for (const line of lines) consume(line); if (done) { consume(buffer); break; } }
    if (!finished) throw new Error('The connection ended before the answer finished.');
  } catch (e) {
    const text = e.name === 'AbortError' ? 'Answer stopped.' : e.message;
    const error = document.createElement('div'); error.className = 'message-error'; error.textContent = text; node.querySelector('.message-body').append(error);
  } finally {
    if (frame) cancelAnimationFrame(frame); paint(); node.classList.remove('streaming');
    $('#summarize-button').disabled = false;
    controller = null; $('#send-button').innerHTML = icon('send'); $('#send-button').ariaLabel = 'Send question';
    $('#activity').textContent = ''; $('#model-select').disabled = false; $('#provider-select').disabled = false;
    $('#question').focus();
  }
}

$('#new-chat').onclick = newChat;
$('#settings-button').onclick = openSettings;
$('#library-button').onclick = openLibrary;
$('#selection-button').onclick = openLibrary;
$('#history-button').onclick = guard(openHistory);
$('#menu-button').onclick = () => $('#sidebar').classList.toggle('open');
$('#sidebar-close').onclick = () => $('#sidebar').classList.remove('open');
$('#close-source').onclick = closeSource;
$('#reopen-source').onclick = () => { $('.app').classList.remove('source-closed'); $('#source-panel').classList.add('opened'); $('#reopen-source').hidden = true; };
document.querySelectorAll('[data-close]').forEach(b => b.onclick = () => b.closest('dialog').close());
document.querySelectorAll('dialog').forEach(d => d.addEventListener('click',e => { if(e.target === d) { const r = d.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) d.close(); } }));
for (const id of ['upload-zone','add-file','attach-button','library-upload']) $('#' + id).onclick = () => $('#file-input').click();
$('#file-input').onchange = guard(e => uploadFiles([...e.target.files]));
$('#upload-zone').ondragover = e => { e.preventDefault(); $('#upload-zone').classList.add('dragover'); };
$('#upload-zone').ondragleave = () => $('#upload-zone').classList.remove('dragover');
$('#upload-zone').ondrop = guard(async e => { e.preventDefault(); $('#upload-zone').classList.remove('dragover'); await uploadFiles([...e.dataTransfer.files]); });
$('#select-all').onclick = () => { selected = new Set(readyDocs().map(d => d.id)); drawDocs(); };
$('#settings-form').onsubmit = guard(async e => {
  e.preventDefault(); if (busy()) return toast('Stop the current answer before changing Settings.');
  const value = Object.fromEntries(new FormData(e.target)); value.top_k = +value.top_k; value.max_tokens = +value.max_tokens;
  $('#settings-status').textContent = 'Saving…';
  await saveConfig(value); $('#settings-dialog').close(); toast('Settings saved. Re-index files if you changed the embedding model.');
});
$('#test-connection').onclick = guard(async () => { $('#settings-status').textContent = 'Connecting…'; const r = await refreshModels(); $('#settings-status').textContent = r.connected ? `Connected. ${r.models.length} models found.` : r.error; });
$('#provider-select').onchange = guard(async e => {
  const old = {...config}; const value = {...config,provider:e.target.value,chat_model:''};
  try { await saveConfig(value); openSettings(); } catch (error) { $('#provider-select').value = old.provider; throw error; }
});
$('#model-select').onchange = guard(async e => { await saveConfig({...config,chat_model:e.target.value}); });
$('#chat-form').onsubmit = sendQuestion;
$('#summarize-button').onclick = event => sendQuestion(event, 'summary');
$('#question').onkeydown = e => { if(e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); if (!busy()) $('#chat-form').requestSubmit(); } };
$('#question').oninput = e => { e.target.style.height = 'auto'; e.target.style.height = Math.min(e.target.scrollHeight,160) + 'px'; };
window.addEventListener('beforeunload',() => controller?.abort());
async function boot() {
  emptyChat(); config = await api('/settings'); $('#provider-select').value = config.provider;
  await Promise.all([refreshDocs(),refreshModels()]);
  if (window.innerWidth <= 980) { closeSource(); }
  setInterval(async () => { if (polling || !docs.some(d => d.status === 'indexing')) return; polling = true; try { await refreshDocs(); } catch {} finally { polling = false; } },1800);
}
boot().catch(e => toast('Cannot connect to the app: ' + e.message));

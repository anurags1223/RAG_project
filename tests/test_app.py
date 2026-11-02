import hashlib
import io
import json

import httpx
import pytest
from fastapi.testclient import TestClient
from pypdf import PdfWriter
from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject

from backend import main
from backend.providers import Provider


def sample_pdf(text='The Going Merry carries 42 books in its library.'):
    writer = PdfWriter()
    page = writer.add_blank_page(width=612, height=792)
    font = DictionaryObject({NameObject('/Type'): NameObject('/Font'), NameObject('/Subtype'): NameObject('/Type1'), NameObject('/BaseFont'): NameObject('/Helvetica')})
    page[NameObject('/Resources')] = DictionaryObject({NameObject('/Font'): DictionaryObject({NameObject('/F1'): writer._add_object(font)})})
    stream = DecodedStreamObject()
    stream.set_data(f'BT /F1 14 Tf 50 700 Td ({text}) Tj ET'.encode())
    page[NameObject('/Contents')] = writer._add_object(stream)
    output = io.BytesIO(); writer.write(output)
    return output.getvalue()


@pytest.fixture
def app(monkeypatch):
    def embed(self, texts, model):
        return [[(int(hashlib.sha256(text.encode()).hexdigest()[i:i+2],16)+1)/256 for i in range(0,32,2)] for text in texts]

    async def stream(self, messages, model, max_tokens):
        assert '42 books' in messages[0]['content']
        assert [x['role'] for x in messages[1:]] == ['user', 'assistant'] * ((len(messages)-2)//2) + ['user']
        yield 'There are '
        yield '42 books [1].'

    monkeypatch.setattr(Provider,'embed',embed)
    monkeypatch.setattr(Provider,'stream',stream)
    main.query_vector.cache_clear()
    with TestClient(main.app) as test:
        yield test


def test_pdf_chat_and_embedding_switch(app):
    config = app.get('/api/settings').json()
    config['chat_model'] = 'test-chat'
    assert app.put('/api/settings',json=config).status_code == 200
    upload = app.post('/api/documents',files={'file':('library.pdf',sample_pdf(),'application/pdf')})
    assert upload.status_code == 202
    doc_id = upload.json()['id']
    doc = next(d for d in app.get('/api/documents').json() if d['id'] == doc_id)
    assert doc['status'] == 'ready' and doc['pages'] == 1
    assert app.post('/api/documents',files={'file':('same.pdf',sample_pdf(),'application/pdf')}).status_code == 409
    assert app.get(f'/api/documents/{doc_id}/file').content.startswith(b'%PDF-')
    response = app.post('/api/chat',json={'question':'How many books?', 'document_ids':[doc_id]})
    events = [json.loads(line) for line in response.text.splitlines()]
    assert events[-1]['type'] == 'done', events
    assert ''.join(e.get('text','') for e in events) == 'There are 42 books [1].'
    sources = next(e['sources'] for e in events if e['type'] == 'sources')
    assert sources[0]['page'] == 1 and sources[0]['document_id'] == doc_id
    cid = events[0]['conversation_id']
    history = app.get(f'/api/conversations/{cid}').json()
    assert [m['role'] for m in history] == ['user','assistant']
    assert history[1]['sources'][0]['name'] == 'library.pdf'
    config['provider'] = 'lmstudio'
    assert app.put('/api/settings',json=config).status_code == 200
    assert next(d for d in app.get('/api/documents').json() if d['id']==doc_id)['status'] == 'ready'
    # Chat provider changes must not invalidate embeddings.
    response = app.post('/api/chat',json={'question':'Books?', 'document_ids':[doc_id]})
    assert json.loads(response.text.splitlines()[-1])['type'] == 'done'
    config['embedding_model'] = 'different-embedding'
    app.put('/api/settings',json=config)
    assert next(d for d in app.get('/api/documents').json() if d['id']==doc_id)['status'] == 'needs_index'
    assert app.post('/api/chat',json={'question':'Books?'}).status_code == 400
    app.post(f'/api/documents/{doc_id}/reindex')
    assert next(d for d in app.get('/api/documents').json() if d['id']==doc_id)['status'] == 'ready'
    assert app.delete(f'/api/documents/{doc_id}').status_code == 200
    assert app.get(f'/api/documents/{doc_id}/file').status_code == 404


def test_bad_upload_and_local_boundaries(app):
    assert app.post('/api/documents',files={'file':('bad.pdf',b'not a PDF')}).status_code == 400
    assert app.post('/api/documents',files={'file':('file.exe',b'%PDF-123')}).status_code == 400
    config = app.get('/api/settings').json(); config['ollama_url'] = 'https://example.com'
    assert app.put('/api/settings',json=config).status_code == 400
    assert app.get('/api/settings',headers={'Origin':'https://unrelated.example'}).status_code == 403
    assert app.get('/').status_code == 200
    assert app.get('/api/documents/../../secret/file').status_code == 404


def test_index_error_is_reported(app,monkeypatch):
    def fail(*args): raise ValueError('Embedding model is missing')
    monkeypatch.setattr(Provider,'embed',fail)
    response = app.post('/api/documents',files={'file':('broken.pdf',sample_pdf('Unique text about 42 books.'))})
    doc = next(d for d in app.get('/api/documents').json() if d['id']==response.json()['id'])
    assert doc['status']=='error' and 'missing' in doc['error']


def test_failed_generation_releases_slot(app,monkeypatch):
    result = app.post('/api/documents',files={'file':('generation.pdf',sample_pdf('Another library has 42 books.'))})
    doc_id = result.json()['id']
    async def fail(*args):
        yield 'Partial answer'
        raise ValueError('The model stopped unexpectedly')
    monkeypatch.setattr(Provider,'stream',fail)
    for _ in range(2):
        response = app.post('/api/chat',json={'question':'How many books?', 'document_ids':[doc_id]})
        events = [json.loads(line) for line in response.text.splitlines()]
        assert events[-1]['type']=='error'
        assert not main.generation_lock.locked()
        history = app.get('/api/conversations/' + events[0]['conversation_id']).json()
        assert '[Response interrupted]' in history[-1]['content']


def test_unanswered_history_is_not_sent_to_strict_chat_templates(app):
    result = app.post('/api/documents',files={'file':('history.pdf',sample_pdf('The history library has 42 books.'))})
    with main.db() as c:
        c.execute('INSERT INTO conversations(id,title) VALUES(?,?)',('canceled-turn','Canceled turn'))
        c.execute('INSERT INTO messages(conversation_id,role,content) VALUES(?,?,?)',('canceled-turn','user','A question that was stopped'))
    response = app.post('/api/chat',json={'question':'How many books?', 'conversation_id':'canceled-turn','document_ids':[result.json()['id']]})
    assert json.loads(response.text.splitlines()[-1])['type']=='done'


@pytest.mark.parametrize('kind',['ollama','lmstudio'])
def test_provider_wire_protocols(kind,monkeypatch):
    real_async,real_sync = httpx.AsyncClient,httpx.Client
    def handler(request):
        if request.url.path.endswith(('tags','models')):
            return httpx.Response(200,json={'models':[{'name':'test'}]} if kind=='ollama' else {'data':[{'id':'test'}]})
        body = json.loads(request.content)
        if request.url.path.endswith(('embed','embeddings')):
            assert body['input']==['hello']
            return httpx.Response(200,json={'embeddings':[[0.1,0.2]]} if kind=='ollama' else {'data':[{'index':0,'embedding':[0.1,0.2]}]})
        assert body['stream'] is True
        if kind=='ollama':
            assert body['options']['num_predict']==128
            content = '{"message":{"content":"Hello"},"done":false}\n{"message":{"content":" world"},"done":true}\n'
        else:
            assert body['max_tokens']==128
            if 'qwen3.5' in body['model']:
                assert body['reasoning_effort']=='none'
            content = 'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\ndata: {"choices":[{"delta":{"content":" world"}}]}\n\ndata: [DONE]\n\n'
        return httpx.Response(200,text=content)
    transport = httpx.MockTransport(handler)
    monkeypatch.setattr(httpx,'AsyncClient',lambda **kwargs: real_async(transport=transport,**kwargs))
    monkeypatch.setattr(httpx,'Client',lambda **kwargs: real_sync(transport=transport,**kwargs))
    p = Provider(kind,'http://localhost:11434' if kind=='ollama' else 'http://localhost:1234/v1')
    import asyncio
    assert asyncio.run(p.models()) == ['test']
    assert p.embed(['hello'],'embedding') == [[0.1,0.2]]
    async def collect():
        return ''.join([x async for x in p.stream([{'role':'user','content':'hello'}],'test',128)])
    assert asyncio.run(collect())=='Hello world'
    if kind=='lmstudio':
        async def collect_qwen():
            return ''.join([x async for x in p.stream([{'role':'user','content':'hello'}],'qwen/qwen3.5-9b',128)])
        assert asyncio.run(collect_qwen())=='Hello world'
